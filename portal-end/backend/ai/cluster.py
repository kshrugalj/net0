"""Incident clustering: proximity first, then Gemini decides the cluster and summary."""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from typing import Any

from sqlalchemy.orm import Session

from ai import prompts as prompt_store
from ai.llm import call_llm, gemini_configured, last_llm_error, parse_llm_json
from models.report import Report
from packets.serial_schema import Category

logger = logging.getLogger(__name__)

VALID_RESPONDERS = {
    "medical_ems",
    "fire_rescue",
    "law_enforcement",
    "technical_sar",
    "humanitarian_care",
    "coast_guard",
}

# A report can join a neighborhood when it is this close to some member.
_NEAR_M = 250.0
# The whole neighborhood still cannot stretch farther than this, so nearby
# reports of one event can join without a chain walking across the city.
_MAX_CLUSTER_DIAMETER_M = 500.0
# Extra Gemini calls for a cluster summary after a blank or one-report reply.
_SUMMARY_ATTEMPTS = 4
_SUMMARY_RETRY_PASSES = 3


def _category_name(code: int | None) -> str:
    try:
        return Category(int(code or 0)).name.lower()
    except ValueError:
        return "unknown"


def _report_payload(report: Report) -> dict[str, Any]:
    return {
        "id": report.id,
        "msg_id": report.msg_id,
        "category": report.category,
        "category_name": _category_name(report.category),
        "people": report.people,
        "location": report.location,
        "message": report.message,
        "gps_lat": report.gps_lat,
        "gps_lon": report.gps_lon,
        "ai_summary": report.ai_summary,
        "ai_responders": report.ai_responders or [],
        "ai_priority": report.ai_priority,
    }


def _meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat_scale = 111_000.0
    lon_scale = 111_000.0 * math.cos(math.radians((lat1 + lat2) / 2.0))
    return math.hypot((lat1 - lat2) * lat_scale, (lon1 - lon2) * lon_scale)


def _pair_span(left: list[Report], right: list[Report]) -> tuple[float, float] | None:
    """Nearest and farthest distance between two groups. None if either lacks GPS."""
    nearest: float | None = None
    farthest = 0.0
    for left_report in left:
        for right_report in right:
            lat1, lon1 = left_report.gps_lat, left_report.gps_lon
            lat2, lon2 = right_report.gps_lat, right_report.gps_lon
            if lat1 is None or lon1 is None or lat2 is None or lon2 is None:
                continue
            gap = _meters(lat1, lon1, lat2, lon2)
            farthest = max(farthest, gap)
            nearest = gap if nearest is None else min(nearest, gap)
    if nearest is None:
        return None
    return nearest, farthest


def _split_tight(reports: list[Report]) -> list[list[Report]]:
    """Group reports that sit near one another without spanning the whole city.

    A report joins when it is within _NEAR_M of some member and the combined
    group still fits inside _MAX_CLUSTER_DIAMETER_M. Reports without GPS are
    left out. Singletons are dropped.
    """
    placed = [report for report in reports if report.gps_lat is not None and report.gps_lon is not None]
    if len(placed) < 2:
        return []

    clusters: list[list[Report]] = [[report] for report in placed]

    while True:
        best_i = -1
        best_j = -1
        best_gap: float | None = None
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                span = _pair_span(clusters[i], clusters[j])
                if span is None:
                    continue
                nearest, farthest = span
                if nearest > _NEAR_M or farthest > _MAX_CLUSTER_DIAMETER_M:
                    continue
                if best_gap is None or nearest < best_gap:
                    best_gap = nearest
                    best_i, best_j = i, j
        if best_i < 0:
            break
        clusters[best_i].extend(clusters[best_j])
        del clusters[best_j]

    return [group for group in clusters if len(group) >= 2]


def _constrain_cluster_size(clusters: list[dict[str, Any]], reports: list[Report]) -> list[dict[str, Any]]:
    """Break any proposed cluster that covers more than a small area.

    A group that already fits keeps its summary and responder list. A group that
    has to be split drops that shared summary — it described the oversized area.
    """
    by_id = {report.id: report for report in reports}
    tightened: list[dict[str, Any]] = []
    for cluster in clusters:
        members = [by_id[report_id] for report_id in cluster.get("report_ids") or [] if report_id in by_id]
        parts = _split_tight(members)
        gps_ids = {
            report.id
            for report in members
            if report.gps_lat is not None and report.gps_lon is not None
        }
        intact = len(parts) == 1 and {report.id for report in parts[0]} == gps_ids and len(gps_ids) >= 2
        for part in parts:
            tightened.append(
                {
                    "report_ids": [report.id for report in part],
                    "summary": cluster.get("summary") if intact else None,
                    "responders": (cluster.get("responders") or []) if intact else [],
                }
            )
    return tightened


def _norm_text(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(str(value).lower().split()).strip(" .\"'")


def _report_phrases(report: Report) -> set[str]:
    phrases: set[str] = set()
    for value in (report.ai_summary, report.message):
        phrase = _norm_text(value)
        if len(phrase) >= 12:
            phrases.add(phrase)
    return phrases


def _summary_copies_one_report(summary: str | None, members: list[Report]) -> bool:
    """True when the text restates one report and leaves the others out."""
    norm = _norm_text(summary)
    if not norm or len(members) < 2:
        return False

    def matches(report: Report) -> bool:
        for phrase in _report_phrases(report):
            if norm == phrase or norm.startswith(phrase) or phrase.startswith(norm):
                return True
        return False

    matched = [report for report in members if matches(report)]
    if not matched:
        return False
    matched_ids = {report.id for report in matched}
    for report in members:
        if report.id in matched_ids:
            continue
        phrases = _report_phrases(report)
        if not phrases:
            continue
        if any(phrase in norm or norm in phrase for phrase in phrases):
            continue
        return True
    return False


def _usable_summary(summary: str | None, members: list[Report]) -> bool:
    text = str(summary or "").strip()
    if len(text) < 8:
        return False
    return not _summary_copies_one_report(text, members)


def _neighborhood_payloads(neighborhoods: list[list[Report]]) -> list[dict[str, Any]]:
    return [
        {
            "proximity_group": index,
            "reports": [_report_payload(report) for report in group],
        }
        for index, group in enumerate(neighborhoods)
    ]


def _clusters_from_neighborhoods(
    parsed: list[dict[str, Any]],
    neighborhoods: list[list[Report]],
) -> list[dict[str, Any]]:
    """Keep model clusters that stay inside one proximity group.

    A proximity group the model never mentions is kept intact so a blank
    response cannot dissolve every nearby set of reports.
    """
    id_to_group: dict[int, int] = {}
    group_ids: list[set[int]] = []
    for index, group in enumerate(neighborhoods):
        ids = {report.id for report in group}
        group_ids.append(ids)
        for report_id in ids:
            id_to_group[report_id] = index

    accepted: list[dict[str, Any]] = []
    covered: set[int] = set()
    for cluster in parsed:
        ids = [report_id for report_id in cluster.get("report_ids") or [] if report_id in id_to_group]
        unique_ids = list(dict.fromkeys(ids))
        groups = {id_to_group[report_id] for report_id in unique_ids}
        if len(groups) != 1 or len(unique_ids) < 2:
            continue
        group_index = next(iter(groups))
        if not set(unique_ids) <= group_ids[group_index]:
            continue
        accepted.append(
            {
                "report_ids": unique_ids,
                "summary": cluster.get("summary"),
                "responders": cluster.get("responders") or [],
            }
        )
        covered.update(unique_ids)

    for group in neighborhoods:
        ids = [report.id for report in group]
        if any(report_id in covered for report_id in ids):
            continue
        accepted.append(
            {
                "report_ids": ids,
                "summary": None,
                "responders": [],
            }
        )
    return accepted


def _ai_identify_clusters(neighborhoods: list[list[Report]]) -> list[dict[str, Any]] | None:
    """Ask Gemini which reports inside each proximity group are one incident."""
    reports = [report for group in neighborhoods for report in group]
    prompt = prompt_store.render(
        "report_cluster",
        groups=json.dumps(_neighborhood_payloads(neighborhoods), default=str),
    )
    raw = call_llm(
        prompt,
        system=(
            "Return only valid JSON. Cluster only within each proximity group. "
            "Include nearby reports that are the same event, including lower-priority ones. "
            "Summarize every report in a cluster, not just one of them."
        ),
        max_output_tokens=2048,
        json_mode=True,
    )
    if not raw:
        logger.warning("Proximity groups kept; Gemini returned no cluster decision")
        return None
    try:
        parsed = _parse_clusters(raw, reports)
    except Exception:
        logger.exception("Failed to parse Gemini cluster decision; keeping proximity groups")
        return None
    return _clusters_from_neighborhoods(parsed, neighborhoods)


def _proximity_clusters(neighborhoods: list[list[Report]]) -> list[dict[str, Any]]:
    return [
        {
            "report_ids": [report.id for report in group],
            "summary": None,
            "responders": [],
        }
        for group in neighborhoods
    ]


def _pending_summaries(
    clusters: list[dict[str, Any]],
    by_id: dict[int, Report],
) -> list[tuple[dict[str, Any], list[Report]]]:
    pending: list[tuple[dict[str, Any], list[Report]]] = []
    for cluster in clusters:
        members = [by_id[report_id] for report_id in cluster.get("report_ids") or [] if report_id in by_id]
        if len(members) < 2:
            continue
        if _usable_summary(cluster.get("summary"), members):
            continue
        if cluster.get("summary"):
            logger.info(
                "Rejecting cluster summary that only describes one report ids=%s",
                [report.id for report in members],
            )
            cluster["summary"] = None
        pending.append((cluster, members))
    return pending


def _request_summaries(
    pending: list[tuple[dict[str, Any], list[Report]]],
) -> dict[frozenset[int], dict[str, Any]]:
    payload = [
        {
            "report_ids": [report.id for report in members],
            "reports": [_report_payload(report) for report in members],
        }
        for _cluster, members in pending
    ]
    prompt = prompt_store.render(
        "cluster_summary",
        clusters=json.dumps(payload, default=str),
    )
    raw = call_llm(
        prompt,
        system="Return only valid JSON. Each summary must cover every report in that cluster.",
        max_output_tokens=2048,
        json_mode=True,
    )
    if not raw:
        return {}
    filled: dict[frozenset[int], dict[str, Any]] = {}
    try:
        parsed_reports = [report for _cluster, members in pending for report in members]
        for item in _parse_clusters(raw, parsed_reports):
            filled[frozenset(item["report_ids"])] = item
    except Exception:
        logger.exception("Failed to parse Gemini cluster summaries")
    return filled


def _keep_existing_summary(cluster: dict[str, Any], members: list[Report]) -> None:
    """Leave the last real model summary in place when a retry comes back empty."""
    existing = next(
        (
            report.cluster_summary
            for report in members
            if _usable_summary(report.cluster_summary, members)
        ),
        None,
    )
    cluster["summary"] = existing


def _summarize_with_ai(clusters: list[dict[str, Any]], by_id: dict[int, Report]) -> bool:
    """Ask Gemini for every missing cluster summary. Returns True when all are filled.

    A blank or one-report reply is not saved. The same prompt is sent again
    until Gemini writes a summary of the whole cluster, or the attempt cap is hit.
    """
    pending = _pending_summaries(clusters, by_id)
    if not pending:
        return True
    if not gemini_configured():
        logger.warning("Cluster summaries left for retry; GEMINI_API_KEY is not set")
        for cluster, members in pending:
            _keep_existing_summary(cluster, members)
        return False

    for attempt in range(1, _SUMMARY_ATTEMPTS + 1):
        if attempt > 1:
            time.sleep(1.5 * (attempt - 1))
        filled = _request_summaries(pending)
        still: list[tuple[dict[str, Any], list[Report]]] = []
        for cluster, members in pending:
            item = filled.get(frozenset(report.id for report in members))
            summary = item.get("summary") if item else None
            if _usable_summary(summary, members):
                cluster["summary"] = str(summary).strip()[:600]
                if item and item.get("responders"):
                    cluster["responders"] = item["responders"]
                continue
            logger.warning(
                "Gemini cluster summary missing or unusable (attempt %s/%s) ids=%s",
                attempt,
                _SUMMARY_ATTEMPTS,
                [report.id for report in members],
            )
            still.append((cluster, members))
        pending = still
        if not pending:
            return True
        if last_llm_error() and "API key" in (last_llm_error() or ""):
            break

    for cluster, members in pending:
        _keep_existing_summary(cluster, members)
    return False


def _apply_groups(
    db: Session,
    reports: list[Report],
    clusters: list[dict[str, Any]],
) -> dict[str, list[Report]]:
    # Re-read so a dispatch that landed during the Gemini call cannot be clustered
    # or flipped back to unresolved by this session.
    open_ids = [report.id for report in reports]
    db.expire_all()
    reports = (
        _open_reports(db)
        .filter(Report.id.in_(open_ids))
        .order_by(Report.created_at.asc(), Report.id.asc())
        .all()
    ) if open_ids else []
    by_id = {report.id: report for report in reports}
    claimed: set[int] = set()
    output: dict[str, list[Report]] = {}

    for index, cluster in enumerate(clusters):
        raw_ids = cluster.get("report_ids") or cluster.get("ids") or []
        ids = [int(item) for item in raw_ids if str(item).isdigit() or isinstance(item, int)]
        members = [by_id[report_id] for report_id in ids if report_id in by_id and report_id not in claimed]
        if len(members) < 2:
            continue
        for report_id in (item.id for item in members):
            claimed.add(report_id)

        cluster_id = f"incident-{min(item.id for item in members)}"
        summary = str(cluster.get("summary") or "").strip()[:600] or None
        responders = [
            item
            for item in (cluster.get("responders") or [])
            if isinstance(item, str) and item in VALID_RESPONDERS
        ]
        # Prefer model list; otherwise union of per-report AI responders.
        if not responders:
            seen: list[str] = []
            for report in members:
                for item in report.ai_responders or []:
                    if item in VALID_RESPONDERS and item not in seen:
                        seen.append(item)
            responders = seen

        for report in members:
            report.cluster_id = cluster_id
            report.cluster_summary = summary
            report.cluster_responders = list(responders)
        output[cluster_id] = members

    for report in reports:
        if report.id in claimed:
            continue
        report.cluster_id = None
        report.cluster_summary = None
        report.cluster_responders = None

    db.commit()
    return output


def _parse_clusters(raw: str, reports: list[Report]) -> list[dict[str, Any]]:
    payload = parse_llm_json(raw)
    clusters = payload.get("clusters") or []
    if not isinstance(clusters, list):
        raise ValueError("clusters must be a list")
    valid_ids = {report.id for report in reports}
    cleaned: list[dict[str, Any]] = []
    for item in clusters:
        if not isinstance(item, dict):
            continue
        ids = []
        for value in item.get("report_ids") or item.get("ids") or []:
            try:
                report_id = int(value)
            except (TypeError, ValueError):
                continue
            if report_id in valid_ids:
                ids.append(report_id)
        if len(ids) < 2:
            continue
        cleaned.append(
            {
                "report_ids": ids,
                "summary": item.get("summary"),
                "responders": item.get("responders") or [],
            }
        )
    return cleaned


def _open_reports(db: Session):
    """Reports still in play. Resolved rows stay stored and are left out."""
    return db.query(Report).filter(Report.resolved.is_(False))


def load_clusters(db: Session) -> dict[str, list[Report]]:
    """Read persisted cluster assignments — no Gemini call."""
    reports = (
        _open_reports(db)
        .filter(Report.cluster_id.isnot(None))
        .order_by(Report.created_at.asc(), Report.id.asc())
        .all()
    )
    groups: dict[str, list[Report]] = {}
    for report in reports:
        cluster_id = report.cluster_id
        if not cluster_id:
            continue
        groups.setdefault(cluster_id, []).append(report)
    return {cluster_id: members for cluster_id, members in groups.items() if len(members) >= 2}


def tighten_stored_clusters(db: Session) -> dict[str, list[Report]]:
    """Re-split clusters already saved in the database. Does not call Gemini."""
    reports = (
        _open_reports(db)
        .filter(Report.cluster_id.isnot(None))
        .order_by(Report.created_at.asc(), Report.id.asc())
        .all()
    )
    by_cluster: dict[str, list[Report]] = {}
    for report in reports:
        if not report.cluster_id:
            continue
        by_cluster.setdefault(report.cluster_id, []).append(report)

    payloads: list[dict[str, Any]] = []
    for members in by_cluster.values():
        summary = next((report.cluster_summary for report in members if report.cluster_summary), None)
        responders = next((report.cluster_responders for report in members if report.cluster_responders), None)
        payloads.append(
            {
                "report_ids": [report.id for report in members],
                "summary": summary,
                "responders": list(responders or []),
            }
        )
    return _apply_groups(db, reports, _constrain_cluster_size(payloads, reports))


_summary_retry_state = threading.Lock()
_summary_retry_scheduled = False
_summary_retry_passes = 0


def _reset_summary_retries() -> None:
    global _summary_retry_passes
    with _summary_retry_state:
        _summary_retry_passes = 0


def _schedule_summary_retry() -> None:
    """Run clustering again after a pause when Gemini did not write every summary."""
    global _summary_retry_scheduled, _summary_retry_passes
    with _summary_retry_state:
        if _summary_retry_scheduled or _summary_retry_passes >= _SUMMARY_RETRY_PASSES:
            if _summary_retry_passes >= _SUMMARY_RETRY_PASSES:
                logger.error("Cluster summaries still missing after Gemini retries")
            return
        _summary_retry_scheduled = True
        _summary_retry_passes += 1

    def _run() -> None:
        global _summary_retry_scheduled
        time.sleep(4)
        with _summary_retry_state:
            _summary_retry_scheduled = False
        from database import SessionLocal

        db = SessionLocal()
        try:
            cluster_reports(db)
        except Exception:
            logger.exception("Cluster summary retry failed")
        finally:
            db.close()

    threading.Thread(target=_run, daemon=True, name="cluster-summary-retry").start()


def cluster_reports(db: Session) -> dict[str, list[Report]]:
    """
    Recluster unresolved reports.

    Nearby reports are grouped by GPS first (about one block). Gemini then
    decides which of those neighbors are the same incident and writes a summary
    of every report in the cluster. Resolved reports stay in the database and
    are not sent to the model.

    Call only when the report set changes (new SOS / startup baseline).
    Prefer load_clusters() for reads.
    """
    reports = _open_reports(db).order_by(Report.created_at.asc(), Report.id.asc()).all()
    if not reports:
        return {}

    neighborhoods = _split_tight(reports)
    if not neighborhoods:
        return _apply_groups(db, reports, [])

    identified = _ai_identify_clusters(neighborhoods)
    clusters = identified if identified is not None else _proximity_clusters(neighborhoods)
    clusters = _constrain_cluster_size(clusters, reports)
    complete = _summarize_with_ai(clusters, {report.id: report for report in reports})
    applied = _apply_groups(db, reports, clusters)
    if complete:
        _reset_summary_retries()
    elif gemini_configured() and "API key" not in (last_llm_error() or ""):
        _schedule_summary_retry()
    return applied


_recluster_state = threading.Lock()
_recluster_pending = False


def enqueue_recluster() -> None:
    """Rebuild clusters from unresolved reports only.

    Parallel dispatches share one refresh so every resolved report is excluded together.
    """
    global _recluster_pending
    with _recluster_state:
        if _recluster_pending:
            return
        _recluster_pending = True

    def _run() -> None:
        global _recluster_pending
        time.sleep(0.5)
        with _recluster_state:
            _recluster_pending = False
        from database import SessionLocal

        db = SessionLocal()
        try:
            cluster_reports(db)
        except Exception:
            logger.exception("Recluster after resolve failed")
        finally:
            db.close()

    threading.Thread(target=_run, daemon=True, name="recluster-open").start()


def enqueue_baseline(msg_id: int | None = None) -> None:
    """
    Baseline pipeline (Agent Mode independent):
    optionally triage one new report, fill missing AI fields, then recluster.
    """

    def _run() -> None:
        from database import SessionLocal
        from ai.agent import ensure_report_ai
        from ai.process import process_report_by_msg_id

        db = SessionLocal()
        try:
            if msg_id is not None:
                process_report_by_msg_id(msg_id, persist=True)
            ensure_report_ai(db)
            cluster_reports(db)
        except Exception:
            logger.exception("Baseline AI/cluster refresh failed msg_id=%s", msg_id)
        finally:
            db.close()

    threading.Thread(
        target=_run,
        daemon=True,
        name=f"baseline-cluster-{msg_id or 'all'}",
    ).start()
