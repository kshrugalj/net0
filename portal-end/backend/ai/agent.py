"""Agent Mode orchestration powered by Gemini."""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ai.cluster import load_clusters
from ai.llm import call_llm, gemini_configured, parse_llm_json
from ai import prompts as prompt_store
from ai.process import apply_result_to_report, process_packet
from models.message import Message
from models.node import Node
from models.report import Report
from models.user import User
from schemas.agent import AgentBriefOut, AgentEvidence, RescuePlan, RoutePoint

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _category_label(report: Report) -> str:
    return {
        1: "medical",
        2: "trapped-person",
        3: "fire",
        4: "flood",
        5: "structural",
        6: "security",
        7: "hazmat",
    }.get(report.category, "emergency")


def ensure_report_ai(db: Session, *, limit: int = 40) -> int:
    """Fill missing per-report AI fields via Gemini (never invent local summaries)."""
    pending = (
        db.query(Report)
        .filter(Report.resolved.is_(False))
        .filter(or_(Report.ai_summary.is_(None), Report.ai_priority.is_(None), Report.ai_responders.is_(None)))
        .order_by(Report.created_at.desc())
        .limit(limit)
        .all()
    )
    if not pending:
        return 0
    if not gemini_configured():
        logger.warning("Skipping report AI triage; GEMINI_API_KEY is not set")
        return 0

    changed = 0
    for report in pending:
        data = {
            "msg_id": report.msg_id,
            "category": report.category,
            "people": report.people,
            "needs": report.needs,
            "location": report.location,
            "message": report.message,
            "gps_lat": report.gps_lat,
            "gps_lon": report.gps_lon,
            "gps_accuracy": report.gps_accuracy,
        }
        result = process_packet(data)
        if result.status != "ok":
            continue
        apply_result_to_report(report, result)
        changed += 1
    if changed:
        db.commit()
    return changed


def _draft_text(report: Report, cluster: list[Report]) -> str:
    """Create a short check-in tied to the selected report, not generic advice."""
    location = report.location.strip() if report.location else "your reported location"
    people_count = report.people or "unknown number of"
    people = f"{people_count} " + ("person" if report.people == 1 else "people")
    detail = " ".join((report.message or "").split())
    if len(detail) > 110:
        detail = f"{detail[:107].rstrip()}..."
    context = f"We received your {_category_label(report)} report at {location} for {people}."
    if detail:
        context += f' You reported: "{detail}"'
    question = "Reply 1 if you can move, 2 if injured, 3 if trapped, or 4 if conditions changed."
    if report.category == 3:
        question = "Reply 1 if you can move, 2 if injured, 3 if trapped, or 4 if smoke/fire is getting worse."
    elif report.category == 4:
        question = "Reply 1 if you are above the water, 2 if injured, 3 if stranded, or 4 if water is rising."
    elif report.category == 5:
        question = "Reply 1 if you can move, 2 if injured, 3 if trapped, or 4 if the structure shifted."
    if len(cluster) > 1:
        context += f" Net0 linked this with {len(cluster) - 1} nearby report(s)."
    return f"{context} {question} Stay where you are unless there is immediate danger.".strip()[:400]


def _network(db: Session) -> list[dict[str, Any]]:
    return [
        {
            "node_id": node.node_id,
            "status": node.status,
            "battery": node.battery,
            "last_seen": node.last_seen.isoformat() if node.last_seen else None,
        }
        for node in db.query(Node).all()
    ]


def _empty_brief(reports: list[Report], groups: dict[str, list[Report]], network: list[dict[str, Any]]) -> AgentBriefOut:
    offline = [item for item in network if str(item.get("status", "")).lower() != "online"]
    return AgentBriefOut(
        report_count=len(reports),
        incident_count=len(groups),
        insight="Gemini brief unavailable — check GEMINI_API_KEY and retry Agent Mode.",
        highlights=[],
        summary="No AI brief was generated.",
        signals=[f"{len(offline)} mesh node(s) offline" if offline else "Mesh path operational"],
        verify=["Whether Gemini returned a usable brief"],
        generated_at=_now(),
    )


def _parse_plan(raw: str, *, report: Report, cluster: list[Report], draft: str) -> RescuePlan:
    payload = parse_llm_json(raw)
    raw_evidence = payload.get("evidence") or []
    evidence: list[AgentEvidence] = []
    for item in raw_evidence:
        if not isinstance(item, dict):
            continue
        evidence.append(
            AgentEvidence(
                label=str(item.get("label", "Agent signal"))[:120],
                detail=str(item.get("detail", ""))[:400],
                tone=item.get("tone") if item.get("tone") in {"confirmed", "warning", "unknown"} else "unknown",
            )
        )
    if not evidence:
        evidence = [
            AgentEvidence(
                label=f"{len(cluster)} linked report(s)",
                detail=report.cluster_summary or report.ai_summary or report.message or "Cluster evidence pending.",
                tone="confirmed" if len(cluster) > 1 else "unknown",
            )
        ]
    confidence = payload.get("confidence")
    if confidence not in {"HIGH", "MEDIUM", "LOW"}:
        confidence = "MEDIUM"
    return RescuePlan(
        report_id=report.id,
        cluster_id=report.cluster_id or f"incident-{report.id}",
        priority=max(1, min(5, int(payload.get("priority") or report.ai_priority or 3))),
        title=str(payload.get("title") or f"Emergency near {report.location or 'reported location'}")[:160],
        summary=str(payload.get("summary") or report.cluster_summary or report.ai_summary or "")[:600],
        approach=str(payload.get("approach") or "Confirm nearest safe access from current reports.")[:300],
        avoid=str(payload.get("avoid") or "Avoid unverified approaches.")[:300],
        confidence=confidence,
        evidence=evidence,
        unknowns=[str(item) for item in (payload.get("unknowns") or [])][:8],
        draft=draft,
        route=[],
        route_label="Route not drawn",
        route_note="Responder GPS is not available in this portal.",
        generated_at=_now(),
    )


def build_plan(
    db: Session,
    report_id: int | None = None,
    responder_position: tuple[float, float] | None = None,
    responder_route: list[RoutePoint] | None = None,
    *,
    groups: dict[str, list[Report]] | None = None,
    ensure_ai: bool = True,
) -> RescuePlan | None:
    del responder_position, responder_route  # portal no longer tracks responder GPS
    if ensure_ai:
        ensure_report_ai(db)
    if groups is None:
        groups = load_clusters(db)
    all_reports = db.query(Report).filter(Report.resolved.is_(False)).all()
    if not all_reports:
        return None
    report = None
    if report_id is not None:
        report = db.get(Report, report_id) or db.query(Report).filter(Report.msg_id == report_id).first()
        if report is not None and report.resolved:
            return None
    if report is None:
        report = max(all_reports, key=lambda item: (item.ai_priority or 0, item.created_at))
    if report is None:
        return None

    cluster = [item for item in groups.get(report.cluster_id or "", [report]) if not item.resolved]
    if report not in cluster:
        cluster = [report]
    network = _network(db)
    draft = _draft_text(report, cluster)

    if not gemini_configured():
        logger.warning("Cannot build agent plan without GEMINI_API_KEY")
        return None

    prompt = prompt_store.render(
        "agent_plan",
        cluster=json.dumps(
            [
                {
                    "id": item.id,
                    "people": item.people,
                    "location": item.location,
                    "message": item.message,
                    "priority": item.ai_priority,
                    "ai_summary": item.ai_summary,
                    "cluster_summary": item.cluster_summary,
                    "responders": item.cluster_responders or item.ai_responders,
                    "gps_lat": item.gps_lat,
                    "gps_lon": item.gps_lon,
                }
                for item in cluster
            ],
            default=str,
        ),
        network=json.dumps(network),
        responder_position=json.dumps(None),
        preferred_route=json.dumps([]),
    )
    raw = call_llm(prompt, system="Return only valid JSON. Do not invent facts or claim any route is safe.")
    if not raw:
        logger.warning("Gemini returned no agent plan")
        return None
    try:
        return _parse_plan(raw, report=report, cluster=cluster, draft=draft)
    except Exception:
        logger.exception("Agent plan generation failed")
        return None


def build_brief(
    db: Session,
    *,
    groups: dict[str, list[Report]] | None = None,
    ensure_ai: bool = True,
) -> AgentBriefOut:
    if ensure_ai:
        ensure_report_ai(db)
    if groups is None:
        groups = load_clusters(db)
    reports = (
        db.query(Report)
        .filter(Report.resolved.is_(False))
        .order_by(Report.created_at.desc())
        .all()
    )
    network = _network(db)
    if not reports:
        return AgentBriefOut(
            report_count=0,
            incident_count=0,
            insight="No emergency reports are currently available.",
            highlights=[],
            summary="Agent Mode is ready and waiting for the next SOS.",
            signals=["Mesh waiting for traffic"],
            verify=[],
            generated_at=_now(),
        )

    if not gemini_configured():
        return _empty_brief(reports, groups, network)

    clusters_payload = [
        {
            "cluster_id": cluster_id,
            "summary": members[0].cluster_summary,
            "responders": members[0].cluster_responders,
            "report_ids": [item.id for item in members],
            "people": sum(item.people or 0 for item in members),
            "locations": list({item.location for item in members if item.location}),
        }
        for cluster_id, members in groups.items()
    ]
    reports_payload = [
        {
            "id": item.id,
            "people": item.people,
            "location": item.location,
            "message": item.message,
            "ai_summary": item.ai_summary,
            "ai_priority": item.ai_priority,
            "cluster_id": item.cluster_id,
            "gps_lat": item.gps_lat,
            "gps_lon": item.gps_lon,
        }
        for item in reports[:80]
    ]
    prompt = prompt_store.render(
        "agent_brief",
        clusters=json.dumps(clusters_payload, default=str),
        reports=json.dumps(reports_payload, default=str),
        network=json.dumps(network),
    )
    raw = call_llm(prompt, system="Return only valid JSON for the operational brief.")
    if not raw:
        return _empty_brief(reports, groups, network)
    try:
        payload = parse_llm_json(raw)
        return AgentBriefOut(
            report_count=len(reports),
            incident_count=len(groups),
            insight=str(payload.get("insight") or f"{len(groups)} incident cluster(s) from {len(reports)} reports.")[:300],
            highlights=[str(item) for item in (payload.get("highlights") or [])][:6],
            summary=str(payload.get("summary") or "")[:800],
            signals=[str(item) for item in (payload.get("signals") or [])][:8],
            verify=[str(item) for item in (payload.get("verify") or [])][:8],
            generated_at=_now(),
        )
    except Exception:
        logger.exception("Failed to parse Gemini brief")
        return _empty_brief(reports, groups, network)


def send_check_in(db: Session, report_id: int, text: str, approved: bool) -> Message:
    if not approved:
        raise ValueError("approved=true is required before sending a check-in")
    report = db.get(Report, report_id)
    if report is None:
        raise LookupError("Report not found")
    user = db.get(User, report.user_id)
    target_node = user.origin if user is not None and user.origin is not None else report.origin
    if target_node is None or not 1 <= target_node <= 254:
        raise ValueError("Report has no valid origin node; cannot route check-in")
    if user is not None and user.origin is None:
        user.origin = target_node
    reply_to = report.msg_id
    from packets.esp_manager import queue_downlink
    from packets.packet_codec import encode_downlink, frame_packet
    from packets.serial_schema import Message as DownlinkMessage

    downlink = DownlinkMessage(target_node=target_node, user_id=report.user_id, reply_to=reply_to, sender="Net0 Agent", text=text)
    msg = Message(
        direction="downlink",
        user_id=report.user_id,
        reply_to=reply_to,
        target_node=target_node,
        sender="Net0 Agent",
        text=text,
        status="pending",
        created_at=_now(),
    )
    db.add(msg)
    db.flush()
    msg.status = "sent" if queue_downlink(frame_packet(encode_downlink(downlink))) else "pending"
    db.commit()
    db.refresh(msg)
    return msg


def enqueue_agent(msg_id: int) -> None:
    """Optional Agent Mode plan refresh. Clustering is handled by enqueue_baseline."""

    def _run() -> None:
        db = SessionLocal()
        try:
            build_plan(db, msg_id)
        except Exception:
            logger.exception("Background Agent Mode refresh failed for msg_id=%s", msg_id)
        finally:
            db.close()

    from database import SessionLocal

    threading.Thread(
        target=_run,
        daemon=True,
        name=f"agent-refresh-{msg_id}",
    ).start()
