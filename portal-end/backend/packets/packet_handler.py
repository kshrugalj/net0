"""
Persist decoded uplink packets into SQL models.

Heartbeat -> upsert Node status
Report    -> upsert User + insert Report (dedup msg_id) + Ack
UserReply -> upsert User + insert Message (dedup msg_id) + Ack
"""
from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy.orm import Session

from ai.cluster import enqueue_baseline
from database import SessionLocal
from models.message import Message as MessageRow
from models.node import Node, utcnow
from models.report import Report as ReportRow
from models.user import User
from packets.packet_codec import encode_downlink, frame_packet
from packets.serial_schema import Ack, Heartbeat, Report, UserReply

# -- configuration --
HEARTBEAT_TIMEOUT_S = 35

# -- logging --
logger = logging.getLogger(__name__)


# -- public --
def handle_uplink(
    pkt: Report | UserReply | Heartbeat,
    send_downlink=None,
) -> None:

    db = SessionLocal()
    new_report_msg_id: int | None = None

    try:

        if isinstance(pkt, Heartbeat):
            _handle_heartbeat(db, pkt)

        elif isinstance(pkt, Report):
            if _handle_report(db, pkt, send_downlink):
                new_report_msg_id = pkt.msg_id

        elif isinstance(pkt, UserReply):
            _handle_user_reply(db, pkt, send_downlink)

        else:
            logger.warning(
                f"Unhandled uplink packet: {type(pkt)}"
            )

        db.commit()

    except Exception:

        db.rollback()
        logger.exception(
            "Failed to handle uplink packet"
        )
        raise

    finally:
        db.close()

    if new_report_msg_id is not None:
        enqueue_baseline(new_report_msg_id)


def mark_stale_nodes_offline() -> int:
    """
    Mark nodes offline when no heartbeat
    for HEARTBEAT_TIMEOUT_S seconds.
    """

    cutoff = utcnow() - timedelta(
        seconds=HEARTBEAT_TIMEOUT_S
    )

    db = SessionLocal()

    try:

        stale = (
            db.query(Node)
            .filter(
                Node.status == "online",
                Node.last_seen < cutoff,
            )
            .all()
        )

        for node in stale:
            node.status = "offline"

        db.commit()

        return len(stale)

    except Exception:

        db.rollback()
        logger.exception(
            "Failed to mark stale nodes offline"
        )
        raise

    finally:
        db.close()


# -- handlers --
def _handle_heartbeat(db: Session, pkt: Heartbeat) -> None:

    neighbors = [
        {
            "id": neighbor.id,
            "rssi": neighbor.rssi,
        }
        for neighbor in pkt.neighbors
    ]

    node = db.get(Node, pkt.node)

    if node is None:

        node = Node(
            node_id=pkt.node,
            role=int(pkt.role),
            status="online",
            clients=pkt.clients,
            path=list(pkt.path),
            uptime_s=pkt.uptime_s,
            tx=pkt.tx,
            rx=pkt.rx,
            battery=pkt.battery,
            neighbors=neighbors,
            last_seen=utcnow(),
        )

        db.add(node)

        logger.info(
            f"Node {pkt.node} online (new)"
        )

        return

    node.role = int(pkt.role)
    node.status = "online"
    node.clients = pkt.clients
    node.path = list(pkt.path)
    node.uptime_s = pkt.uptime_s
    node.tx = pkt.tx
    node.rx = pkt.rx
    node.battery = pkt.battery
    node.neighbors = neighbors
    node.last_seen = utcnow()

    logger.info(
        f"Node {pkt.node} heartbeat"
    )


def _handle_report(
    db: Session,
    pkt: Report,
    send_downlink,
) -> bool:
    """Persist a new report. Returns True if a new row was inserted."""

    _upsert_user(
        db,
        user_id=pkt.user_id,
        name=pkt.name,
        phone=pkt.phone,
        origin=pkt.origin,
    )

    existing = (
        db.query(ReportRow)
        .filter(ReportRow.msg_id == pkt.msg_id)
        .first()
    )

    if existing is not None:

        logger.info(
            f"Duplicate report msg_id={pkt.msg_id} (attempt={pkt.attempt})"
        )

        _send_ack(
            send_downlink,
            target_node=pkt.origin,
            user_id=pkt.user_id,
            acked_msg_id=pkt.msg_id,
        )

        return False

    gps_lat = None
    gps_lon = None
    gps_accuracy = None

    if pkt.gps is not None:
        gps_lat = pkt.gps.lat
        gps_lon = pkt.gps.lon
        gps_accuracy = pkt.gps.accuracy_m

    report = ReportRow(
        msg_id=pkt.msg_id,
        attempt=pkt.attempt,
        user_id=pkt.user_id,
        origin=pkt.origin,
        path=list(pkt.path),
        category=int(pkt.category),
        people=pkt.people,
        needs=pkt.needs,
        gps_lat=gps_lat,
        gps_lon=gps_lon,
        gps_accuracy=gps_accuracy,
        location=pkt.location,
        message=pkt.message,
        status="received",
        resolved=False,
    )

    report.acked_at = utcnow()
    db.add(report)

    logger.info(
        f"Saved report msg_id={pkt.msg_id} user={pkt.user_id}"
    )

    _send_ack(
        send_downlink,
        target_node=pkt.origin,
        user_id=pkt.user_id,
        acked_msg_id=pkt.msg_id,
    )

    return True


def _handle_user_reply(
    db: Session,
    pkt: UserReply,
    send_downlink,
) -> None:

    _upsert_user(
        db,
        user_id=pkt.user_id,
        origin=pkt.origin,
    )

    existing = (
        db.query(MessageRow)
        .filter(MessageRow.msg_id == pkt.msg_id)
        .first()
    )

    if existing is not None:

        logger.info(
            f"Duplicate user_reply msg_id={pkt.msg_id} (attempt={pkt.attempt})"
        )

        _send_ack(
            send_downlink,
            target_node=pkt.origin,
            user_id=pkt.user_id,
            acked_msg_id=pkt.msg_id,
        )

        return

    message = MessageRow(
        msg_id=pkt.msg_id,
        direction="uplink",
        user_id=pkt.user_id,
        reply_to=pkt.reply_to,
        target_node=pkt.origin,
        path=list(pkt.path),
        sender="",
        text=pkt.text,
        status="received",
    )

    db.add(message)

    logger.info(
        f"Saved user_reply msg_id={pkt.msg_id} user={pkt.user_id}"
    )

    _send_ack(
        send_downlink,
        target_node=pkt.origin,
        user_id=pkt.user_id,
        acked_msg_id=pkt.msg_id,
    )


def _upsert_user(
    db: Session,
    user_id: int,
    name: str = "",
    phone: str = "",
    origin: int | None = None,
) -> User:

    user = db.get(User, user_id)

    if user is None:

        user = User(
            user_id=user_id,
            name=name,
            phone=phone,
            origin=origin,
            first_seen=utcnow(),
            last_seen=utcnow(),
        )

        db.add(user)

        return user

    if name:
        user.name = name

    if phone:
        user.phone = phone

    if origin is not None:
        user.origin = origin

    user.last_seen = utcnow()

    return user


def _send_ack(
    send_downlink,
    target_node: int,
    user_id: int,
    acked_msg_id: int,
) -> None:

    if send_downlink is None:
        return

    ack = Ack(
        target_node=target_node,
        user_id=user_id,
        acked_msg_id=acked_msg_id,
    )

    framed = frame_packet(
        encode_downlink(ack)
    )

    send_downlink(framed)

    logger.info(
        f"Queued ack msg_id={acked_msg_id} -> node {target_node}"
    )
