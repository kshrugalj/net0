"""One-step dispatcher. Gemini picks the next portal action; routing stays in code."""
from __future__ import annotations

import logging
import math
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ai import prompts as prompt_store
from ai.llm import call_llm, gemini_configured, last_llm_error, parse_llm_json
from models.message import Message
from models.report import Report
from packets.serial_schema import Category, decode_needs
from schemas.agent import DispatcherActionOut, DispatcherBoardOut

logger = logging.getLogger(__name__)

_MAX_OUTPUT_TOKENS = 512
_THOUGHT_MAX = 160
_TEXT_MAX = 400
_SUMMARY_MAX = 80
_PENDING_MAX = 12


_CREW_BY_RESPONDER = {
    "medical_ems": "medical",
    "fire_rescue": "fire",
    "law_enforcement": "law",
    "technical_sar": "sar",
    "humanitarian_care": "care",
    "coast_guard": "coast",
}
_CREW_BY_CATEGORY = {
    "medical": "medical",
    "trapped": "sar",
    "fire": "fire",
    "flood": "coast",
    "structural": "sar",
    "security": "law",
    "hazmat": "fire",
}
_MAX_STOPS = 6
_MAX_LEG_M = 1_500.0


def _category_name(code: int | None) -> str:
    try:
        return Category(int(code or 0)).name.lower()
    except ValueError:
        return "unknown"


def _crew(report: Report) -> str:
    for responder in report.ai_responders or []:
        if responder in _CREW_BY_RESPONDER:
            return _CREW_BY_RESPONDER[responder]
    return _CREW_BY_CATEGORY.get(_category_name(report.category), "general")


def _has_gps(report: Report) -> bool:
    return report.gps_lat is not None and report.gps_lon is not None


def _meters(left: Report, right: Report) -> float:
    if not _has_gps(left) or not _has_gps(right):
        return 0.0
    lat1 = float(left.gps_lat or 0)
    lon1 = float(left.gps_lon or 0)
    lat2 = float(right.gps_lat or 0)
    lon2 = float(right.gps_lon or 0)
    lat_scale = 111_000.0
    lon_scale = 111_000.0 * math.cos(math.radians((lat1 + lat2) / 2.0))
    return math.hypot((lat1 - lat2) * lat_scale, (lon1 - lon2) * lon_scale)


def _need_key(report: Report) -> tuple[int, int, int]:
    return (report.ai_priority or 0, report.people or 0, -report.id)


def plan_run(reports: list[Report]) -> list[Report]:
    """Highest need, one help type, then nearby stops in visit order."""
    if not reports:
        return []
    seed = max(reports, key=_need_key)
    crew = _crew(seed)
    floor = max(1, (seed.ai_priority or 1) - 1)
    pool = [
        report
        for report in reports
        if report.id != seed.id and _crew(report) == crew and (report.ai_priority or 0) >= floor
    ]
    route = [seed]
    while pool and len(route) < _MAX_STOPS:
        end = route[-1]
        pool.sort(key=lambda report: _meters(end, report) if _has_gps(end) and _has_gps(report) else 10**9)
        nxt = pool.pop(0)
        if not (_has_gps(end) and _has_gps(nxt)):
            break
        if _meters(end, nxt) > _MAX_LEG_M:
            break
        route.append(nxt)
    ordered = [route[0]]
    rest = route[1:]
    while rest:
        end = ordered[-1]
        rest.sort(key=lambda report: _meters(end, report) if _has_gps(end) and _has_gps(report) else 10**9)
        ordered.append(rest.pop(0))
    return ordered


def _recommended_line(route: list[Report]) -> str:
    if not route:
        return "(none)"
    crew = _crew(route[0])
    priority = route[0].ai_priority or 0
    ids = ",".join(str(report.id) for report in route)
    span = 0.0
    for index in range(1, len(route)):
        span += _meters(route[index - 1], route[index])
    return f"ids={ids} help={crew} priority={priority} travel_m={int(span)}"


def _clip(value: str | None, limit: int) -> str:
    text = " ".join((value or "").split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3].rstrip()}..."


def board_fingerprint(report_ids: list[int], pending_message_ids: list[int]) -> str:
    reports = ",".join(str(item) for item in sorted(report_ids))
    pending = ",".join(str(item) for item in sorted(pending_message_ids))
    return f"r:{reports}|m:{pending}"


def _open_reports(db: Session) -> list[Report]:
    return (
        db.query(Report)
        .filter(Report.resolved.is_(False))
        .order_by(Report.created_at.asc(), Report.id.asc())
        .all()
    )


def _is_auto_dispatch(text: str | None) -> bool:
    body = " ".join((text or "").split())
    return body.startswith("Dispatch #") and "sent for your" in body


def _pending_replies(db: Session) -> list[Message]:
    """Inbound texts with no real reply yet. The automatic dispatch notice does not count."""
    user_ids = [
        user_id
        for (user_id,) in db.query(Message.user_id).filter(Message.user_id.isnot(None)).distinct()
    ]
    pending: list[Message] = []
    for user_id in user_ids:
        rows = (
            db.query(Message)
            .filter(Message.user_id == user_id)
            .order_by(Message.id.desc())
            .limit(40)
            .all()
        )
        latest_uplink = next((row for row in rows if row.direction == "uplink"), None)
        if latest_uplink is None or latest_uplink.id is None:
            continue
        later = [
            row
            for row in rows
            if row.direction == "downlink" and row.id is not None and row.id > latest_uplink.id
        ]
        if any(not _is_auto_dispatch(row.text) for row in later):
            continue
        pending.append(latest_uplink)
    pending.sort(key=lambda row: row.id or 0)
    return pending


def _snapshot_lines(reports: list[Report], queued: set[int], *, include_status: bool = False) -> str:
    if not reports:
        return "(none)"
    lines = []
    for report in reports:
        summary = _clip(report.ai_summary or report.message, _SUMMARY_MAX)
        ack = "yes" if report.acked_at is not None or report.status == "acknowledged" else "no"
        lat = f"{report.gps_lat:.4f}" if report.gps_lat is not None else ""
        lon = f"{report.gps_lon:.4f}" if report.gps_lon is not None else ""
        lines.append(
            " ".join(
                [
                    f"id={report.id}",
                    f"user={report.user_id}",
                    f"pri={report.ai_priority or 0}",
                    f"cat={_category_name(report.category)}",
                    f"help={_crew(report)}",
                    f"people={report.people or 0}",
                    f"lat={lat}",
                    f"lon={lon}",
                    f"loc={report.location or ''}",
                    f"ack={ack}",
                    f"queued={'yes' if report.id in queued else 'no'}",
                    f"resolved={'yes' if report.resolved else 'no'}" if include_status else "",
                    f"summary={summary}",
                ]
            )
        )
    return "\n".join(lines)


def _pending_lines(pending: list[Message]) -> str:
    if not pending:
        return "(none)"
    shown = pending[:_PENDING_MAX]
    lines = [
        f"user={row.user_id} msg={row.id} text={_clip(row.text, _SUMMARY_MAX)}"
        for row in shown
    ]
    extra = len(pending) - len(shown)
    if extra > 0:
        lines.append(f"{extra} more inbound texts not shown")
    return "\n".join(lines)


def _wait(thought: str, fingerprint: str, *, gemini_ok: bool = True) -> DispatcherActionOut:
    return DispatcherActionOut(
        thought=_clip(thought, _THOUGHT_MAX) or "Waiting.",
        type="wait",
        fingerprint=fingerprint,
        gemini_ok=gemini_ok,
    )


def _route_action(
    action: DispatcherActionOut,
    reports: list[Report],
    *,
    queued: set[int],
    fingerprint: str,
) -> DispatcherActionOut:
    """Keep routing on need, help type, and travel. Leave real replies alone."""
    if action.type in {"message", "open_messages"}:
        return action
    route = plan_run(reports)
    ids = [report.id for report in route]
    if ids and queued == set(ids):
        return DispatcherActionOut(
            thought=action.thought if action.type == "dispatch" else "Route is set. Sending this run.",
            type="dispatch",
            fingerprint=fingerprint,
            gemini_ok=action.gemini_ok,
        )
    if not ids:
        if queued:
            return DispatcherActionOut(
                thought="Sending the queued run.",
                type="dispatch",
                fingerprint=fingerprint,
                gemini_ok=action.gemini_ok,
            )
        return action
    crew = _crew(route[0])
    priority = route[0].ai_priority or 0
    same_ids = action.type == "queue" and set(action.report_ids) == set(ids)
    thought = action.thought if same_ids else f"P{priority} {crew} run. {len(ids)} nearby stop(s)."
    return DispatcherActionOut(
        thought=_clip(thought, _THOUGHT_MAX),
        type="queue",
        report_ids=ids,
        fingerprint=fingerprint,
        gemini_ok=action.gemini_ok,
    )


def _fallback_action(
    reports: list[Report],
    *,
    queued: set[int],
    fingerprint: str,
) -> DispatcherActionOut:
    """Keep the run moving when Gemini returns a blank or unreadable body."""
    return _route_action(
        _wait("Gemini reply was blank.", fingerprint),
        reports,
        queued=queued,
        fingerprint=fingerprint,
    )


def _top_open(reports: list[Report]) -> Report | None:
    if not reports:
        return None
    return max(reports, key=lambda report: (report.ai_priority or 0, report.id))


def normalize_action(
    payload: dict[str, Any],
    *,
    open_ids: set[int],
    open_user_ids: set[int],
    pending_user_ids: set[int],
    queued_ids: set[int],
    suppressed_user_ids: set[int],
    reports_by_id: dict[int, Report],
    fingerprint: str,
) -> DispatcherActionOut:
    """Validate one model action. Unknown ids and double-texts become a safe action."""
    if "type" not in payload and isinstance(payload.get("actions"), list) and payload["actions"]:
        first = payload["actions"][0]
        payload = first if isinstance(first, dict) else {}

    kind = str(payload.get("type") or "wait")
    thought = _clip(str(payload.get("thought") or ""), _THOUGHT_MAX) or "Next step."
    allowed_users = open_user_ids | pending_user_ids

    if kind == "focus":
        try:
            report_id = int(payload.get("report_id"))
        except (TypeError, ValueError):
            report_id = 0
        if report_id not in open_ids:
            return _wait("That report is not open.", fingerprint)
        return DispatcherActionOut(
            thought=thought, type="focus", report_id=report_id, fingerprint=fingerprint
        )

    if kind == "queue":
        ids: list[int] = []
        for value in payload.get("report_ids") or []:
            try:
                report_id = int(value)
            except (TypeError, ValueError):
                continue
            if report_id in open_ids and report_id not in ids:
                ids.append(report_id)
        if not ids:
            top = _top_open([reports_by_id[item] for item in open_ids if item in reports_by_id])
            if top is None:
                return _wait("No open reports to queue.", fingerprint)
            ids = [top.id]
            thought = thought or "Queue the highest priority report."
        return DispatcherActionOut(
            thought=thought, type="queue", report_ids=ids, fingerprint=fingerprint
        )

    if kind == "dispatch":
        queued_open = [report_id for report_id in queued_ids if report_id in open_ids]
        if not queued_open:
            top = _top_open(list(reports_by_id.values()))
            if top is None:
                return _wait("Nothing is queued to send.", fingerprint)
            return DispatcherActionOut(
                thought="Queue the highest priority report before sending.",
                type="queue",
                report_ids=[top.id],
                fingerprint=fingerprint,
            )
        return DispatcherActionOut(thought=thought, type="dispatch", fingerprint=fingerprint)

    if kind == "message":
        try:
            user_id = int(payload.get("user_id"))
        except (TypeError, ValueError):
            user_id = 0
        text = _clip(str(payload.get("text") or ""), _TEXT_MAX)
        if user_id not in allowed_users or not text:
            return _wait("No reply to send.", fingerprint)
        if user_id in suppressed_user_ids:
            remaining = [
                report
                for report in reports_by_id.values()
                if report.user_id != user_id and report.id not in queued_ids
            ]
            top = _top_open(remaining)
            if top is not None:
                return DispatcherActionOut(
                    thought="Dispatch already texted them. Moving to the next report.",
                    type="focus",
                    report_id=top.id,
                    fingerprint=fingerprint,
                )
            return _wait("Dispatch already texted them.", fingerprint)
        return DispatcherActionOut(
            thought=thought,
            type="message",
            user_id=user_id,
            text=text,
            fingerprint=fingerprint,
        )

    if kind == "open_messages":
        try:
            user_id = int(payload.get("user_id"))
        except (TypeError, ValueError):
            user_id = 0
        if user_id not in allowed_users:
            return _wait("That person is not on the board.", fingerprint)
        return DispatcherActionOut(
            thought=thought, type="open_messages", user_id=user_id, fingerprint=fingerprint
        )

    return _wait(thought if kind == "wait" else "Nothing else to do.", fingerprint)


def load_board(db: Session) -> tuple[list[Report], list[Message], str]:
    reports = _open_reports(db)
    pending = _pending_replies(db)
    fingerprint = board_fingerprint(
        [report.id for report in reports],
        [row.id for row in pending if row.id is not None],
    )
    return reports, pending, fingerprint


def board_status(db: Session) -> DispatcherBoardOut:
    reports, pending, fingerprint = load_board(db)
    return DispatcherBoardOut(
        fingerprint=fingerprint,
        unresolved_count=len(reports),
        pending_replies=len(pending),
    )


def _reply_target(db: Session, pending: list[Message], reports: list[Report]) -> Message | None:
    """Most urgent unanswered text, then the one that has been waiting longest."""
    if not pending:
        return None
    priority: dict[int, int] = {}
    for report in reports:
        current = priority.get(report.user_id, 0)
        priority[report.user_id] = max(current, report.ai_priority or 0)
    missing = [row.user_id for row in pending if row.user_id is not None and row.user_id not in priority]
    if missing:
        for user_id, level in (
            db.query(Report.user_id, Report.ai_priority).filter(Report.user_id.in_(missing)).all()
        ):
            current = priority.get(user_id, 0)
            priority[user_id] = max(current, level or 0)
    return min(pending, key=lambda row: (-priority.get(row.user_id or 0, 0), row.id or 0))


def _context_reports(db: Session, user_id: int) -> list[Report]:
    return (
        db.query(Report)
        .filter(Report.user_id == user_id)
        .order_by(Report.created_at.asc(), Report.id.asc())
        .all()
    )


def _report_blocks(reports: list[Report]) -> str:
    if not reports:
        return "(none)"
    blocks = []
    for report in reports:
        needs = ", ".join(decode_needs(report.needs or 0)) or "none"
        status = "closed" if report.resolved else "open"
        blocks.append(
            "\n".join(
                [
                    f"Report {report.id} ({status})",
                    f"priority: {report.ai_priority or 0}",
                    f"type: {_category_name(report.category)}",
                    f"help: {_crew(report)}",
                    f"people: {report.people or 0}",
                    f"needs: {needs}",
                    f"location: {report.location or ''}",
                    f"their report: {report.message or ''}",
                    f"summary: {report.ai_summary or ''}",
                ]
            )
        )
    return "\n\n".join(blocks)


def _thread_lines(db: Session, user_id: int) -> str:
    rows = (
        db.query(Message)
        .filter(Message.user_id == user_id)
        .order_by(Message.id.asc())
        .all()
    )
    if not rows:
        return "(none)"
    lines = []
    for row in rows:
        speaker = "them" if row.direction == "uplink" else "dispatch"
        lines.append(f"{speaker}: {row.text or ''}")
    return "\n".join(lines)


def _fallback_reply(inbound: str) -> str:
    words = _clip(inbound, 120)
    if words:
        return (
            f"I hear you. You said: {words} "
            "Stay as safe as you can, and tell me what changed so I can keep helping."
        )
    return "I hear you. Stay as safe as you can, and tell me what is happening right now so I can help."


def _answer_pending(
    db: Session,
    pending: list[Message],
    reports: list[Report],
    fingerprint: str,
) -> DispatcherActionOut | None:
    """Reply before the next route, including texts that arrived before Agent Mode."""
    target = _reply_target(db, pending, reports)
    if target is None or target.user_id is None:
        return None
    user_id = int(target.user_id)
    context = _context_reports(db, user_id)
    inbound = (target.text or "").strip() or "(empty)"
    prompt = prompt_store.render(
        "agent_reply",
        inbound=inbound,
        thread=_thread_lines(db, user_id),
        reports=_report_blocks(context),
    )
    raw = call_llm(
        prompt,
        system="You are a sympathetic first-responder dispatcher. Reply with one JSON object only. No markdown.",
        max_output_tokens=384,
        json_mode=True,
    )
    thought = "Answering their text."
    text = ""
    if raw:
        try:
            payload = parse_llm_json(raw)
        except Exception:
            logger.exception("Reply was not valid JSON")
            payload = {}
        text = _clip(str(payload.get("text") or ""), _TEXT_MAX)
        thought = _clip(str(payload.get("thought") or thought), _THOUGHT_MAX) or thought
    if not text:
        if last_llm_error() and "API key" in last_llm_error():
            return _wait(last_llm_error() or "Gemini rejected the API key. Agent paused.", fingerprint, gemini_ok=False)
        text = _fallback_reply(inbound if inbound != "(empty)" else "")
        thought = "Sending a short reply to their text."
    return DispatcherActionOut(
        thought=thought,
        type="message",
        user_id=user_id,
        text=text,
        fingerprint=fingerprint,
    )


def next_action(
    db: Session,
    *,
    queued_report_ids: list[int],
    suppressed_user_ids: list[int],
    previous_action: str = "",
) -> DispatcherActionOut:
    reports, pending, fingerprint = load_board(db)
    if not reports and not pending:
        return _wait("Board is clear.", fingerprint)

    if pending:
        if not gemini_configured():
            logger.warning("Dispatcher paused; GEMINI_API_KEY is not set")
            return _wait("GEMINI_API_KEY is not set. Agent paused.", fingerprint, gemini_ok=False)
        reply = _answer_pending(db, pending, reports, fingerprint)
        if reply is not None:
            return reply

    if not gemini_configured():
        logger.warning("Dispatcher paused; GEMINI_API_KEY is not set")
        return _wait("GEMINI_API_KEY is not set. Agent paused.", fingerprint, gemini_ok=False)

    queued = {int(item) for item in queued_report_ids}
    suppressed = {int(item) for item in suppressed_user_ids}
    recommended = _recommended_line(plan_run(reports))
    prompt = prompt_store.render(
        "agent_dispatch",
        reports=_snapshot_lines(reports, queued),
        recommended=recommended,
        queued=", ".join(str(report.id) for report in reports if report.id in queued) or "(none)",
        already_notified=", ".join(str(item) for item in sorted(suppressed)) or "(none)",
        pending=_pending_lines(pending),
        previous=(previous_action or "(none)")[:200],
    )
    raw = call_llm(
        prompt,
        system="Reply with one JSON object only. No markdown.",
        max_output_tokens=_MAX_OUTPUT_TOKENS,
        json_mode=True,
    )
    if not raw:
        if last_llm_error() and "API key" in last_llm_error():
            return _wait(last_llm_error() or "Gemini rejected the API key. Agent paused.", fingerprint, gemini_ok=False)
        logger.warning("Gemini returned no dispatcher action; using the planned route")
        return _fallback_action(reports, queued=queued, fingerprint=fingerprint)

    try:
        payload = parse_llm_json(raw)
    except Exception:
        logger.exception("Dispatcher action was not valid JSON; using the planned route")
        return _fallback_action(reports, queued=queued, fingerprint=fingerprint)

    reports_by_id = {report.id: report for report in reports}
    action = normalize_action(
        payload,
        open_ids=set(reports_by_id),
        open_user_ids={report.user_id for report in reports},
        pending_user_ids={row.user_id for row in pending if row.user_id is not None},
        queued_ids=queued,
        suppressed_user_ids=suppressed,
        reports_by_id=reports_by_id,
        fingerprint=fingerprint,
    )
    return _route_action(action, reports, queued=queued, fingerprint=fingerprint)
