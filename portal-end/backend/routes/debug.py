import json
import random
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import text

from database import Base, engine, get_db, SessionLocal
from models.user import User
from models.report import Report
from models.node import Node, utcnow
from models.message import Message
from packets.packet_handler import handle_uplink
from packets.serial_schema import Report as ReportPkt, UserReply as UserReplyPkt, Heartbeat as HeartbeatPkt, Neighbor, Role

router = APIRouter(prefix="/api/debug", tags=["debug"])


# ---------- export / import / reset ----------

@router.get("/export")
def export_db(db: Session = Depends(get_db)):
    """Dump all tables as JSON (same format as seed_data.json)."""
    users = db.query(User).all()
    reports = db.query(Report).all()
    nodes = db.query(Node).all()
    messages = db.query(Message).all()

    def ser_user(u: User):
        return {"user_id": u.user_id, "name": u.name, "phone": u.phone, "first_seen": u.first_seen.isoformat() if u.first_seen else None, "last_seen": u.last_seen.isoformat() if u.last_seen else None}

    def ser_report(r: Report):
        return {
            "id": r.id, "msg_id": r.msg_id, "attempt": r.attempt, "user_id": r.user_id, "origin": r.origin, "path": r.path,
            "category": r.category, "people": r.people, "needs": r.needs,
            "gps_lat": r.gps_lat, "gps_lon": r.gps_lon, "gps_accuracy": r.gps_accuracy,
            "location": r.location, "message": r.message, "created_at": r.created_at.isoformat() if r.created_at else None,
            "acked_at": r.acked_at.isoformat() if r.acked_at else None, "status": r.status,
            "resolved": bool(r.resolved),
            "ai_priority": r.ai_priority, "ai_category": r.ai_category, "ai_summary": r.ai_summary,
            "ai_responders": r.ai_responders,
        }

    def ser_node(n: Node):
        return {
            "node_id": n.node_id, "role": n.role, "status": n.status, "clients": n.clients, "path": n.path,
            "uptime_s": n.uptime_s, "tx": n.tx, "rx": n.rx, "battery": n.battery, "neighbors": n.neighbors,
            "last_seen": n.last_seen.isoformat() if n.last_seen else None,
        }

    def ser_msg(m: Message):
        return {
            "id": m.id, "msg_id": m.msg_id, "direction": m.direction, "user_id": m.user_id, "reply_to": m.reply_to,
            "target_node": m.target_node, "path": m.path, "sender": m.sender, "text": m.text, "status": m.status,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }

    return {"users": [ser_user(u) for u in users], "reports": [ser_report(r) for r in reports], "nodes": [ser_node(n) for n in nodes], "messages": [ser_msg(m) for m in messages]}


class ImportPayload(BaseModel):
    users: list[dict] = Field(default_factory=list)
    reports: list[dict] = Field(default_factory=list)
    nodes: list[dict] = Field(default_factory=list)
    messages: list[dict] = Field(default_factory=list)
    mode: str = Field(default="merge", description="merge or replace")

@router.post("/import")
def import_db(payload: ImportPayload, db: Session = Depends(get_db)):
    """Import JSON previously exported. mode=replace truncates first; merge upserts."""
    if payload.mode == "replace":
        # delete in FK order
        db.query(Report).delete()
        db.query(Message).delete()
        db.query(Node).delete()
        db.query(User).delete()
        db.commit()

    # users first
    for u in payload.users:
        uid = u.get("user_id")
        if uid is None:
            continue
        existing = db.get(User, uid)
        if existing:
            if payload.mode == "replace":
                pass  # already deleted
            else:
                # update
                existing.name = u.get("name", existing.name)
                existing.phone = u.get("phone", existing.phone)
                continue
        # parse dates
        def parse_dt(s):
            if not s:
                return datetime.now(timezone.utc)
            try:
                return datetime.fromisoformat(s.replace("Z", "+00:00"))
            except:
                return datetime.now(timezone.utc)
        user = User(user_id=uid, name=u.get("name",""), phone=u.get("phone",""), first_seen=parse_dt(u.get("first_seen")), last_seen=parse_dt(u.get("last_seen")))
        db.merge(user)
    db.flush()

    def parse_dt2(s):
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except:
            return None

    for n in payload.nodes:
        nid = n.get("node_id")
        if nid is None:
            continue
        desired_last = utcnow() if n.get("status") == "online" else (parse_dt2(n.get("last_seen")) or utcnow())
        if db.get(Node, nid) and payload.mode != "replace":
            # update
            node = db.get(Node, nid)
            for k in ["role","status","clients","path","uptime_s","tx","rx","battery","neighbors"]:
                if k in n:
                    setattr(node, k, n[k])
            node.last_seen = desired_last
            continue
        # create
        node = Node(
            node_id=nid, role=n.get("role",1), status=n.get("status","offline"), clients=n.get("clients",0),
            path=n.get("path"), uptime_s=n.get("uptime_s",0), tx=n.get("tx",0), rx=n.get("rx",0),
            battery=n.get("battery"), neighbors=n.get("neighbors",[]),
            last_seen=desired_last,
        )
        db.merge(node)
    db.flush()

    for r in payload.reports:
        msg_id = r.get("msg_id")
        if msg_id is None:
            continue
        existing = db.query(Report).filter(Report.msg_id == msg_id).first()
        if existing and payload.mode != "replace":
            continue
        # ensure user exists
        uid = r.get("user_id")
        if uid and not db.get(User, uid):
            db.merge(User(user_id=uid, name="", phone="", first_seen=utcnow(), last_seen=utcnow()))
            db.flush()
        report = Report(
            id=r.get("id") if payload.mode=="replace" else None, # let autoincrement if merge
            msg_id=msg_id, attempt=r.get("attempt",0), user_id=uid, origin=r.get("origin",1), path=r.get("path",[1]),
            category=r.get("category",0), people=r.get("people",0), needs=r.get("needs",0),
            gps_lat=r.get("gps_lat"), gps_lon=r.get("gps_lon"), gps_accuracy=r.get("gps_accuracy"),
            location=r.get("location",""), message=r.get("message",""),
            created_at=parse_dt2(r.get("created_at")) or utcnow(), acked_at=parse_dt2(r.get("acked_at")),
            status=r.get("status","received"),
            resolved=bool(r.get("resolved", str(r.get("status", "")).lower() in {"resolved", "closed"})),
            ai_priority=r.get("ai_priority"), ai_category=r.get("ai_category"), ai_summary=r.get("ai_summary"),
            ai_responders=r.get("ai_responders"),
        )
        # if merge and existing, skip already handled; if replace, insert
        if payload.mode == "replace" and existing:
            # already deleted in replace mode? but if mode replace we deleted all first, so no existing
            pass
        db.add(report)
    db.flush()

    for m in payload.messages:
        # messages dedup on msg_id if present
        mid = m.get("msg_id")
        if mid is not None:
            existing = db.query(Message).filter(Message.msg_id == mid).first()
            if existing and payload.mode != "replace":
                continue
        uid = m.get("user_id")
        if uid and not db.get(User, uid):
            db.merge(User(user_id=uid, name="", phone="", first_seen=utcnow(), last_seen=utcnow()))
            db.flush()
        msg = Message(
            msg_id=mid, direction=m.get("direction","downlink"), user_id=uid, reply_to=m.get("reply_to",0),
            target_node=m.get("target_node"), path=m.get("path"), sender=m.get("sender",""), text=m.get("text",""),
            status=m.get("status","pending"), created_at=parse_dt2(m.get("created_at")) or utcnow(),
        )
        db.add(msg)

    db.commit()
    return {"status": "ok", "imported": {"users": len(payload.users), "nodes": len(payload.nodes), "reports": len(payload.reports), "messages": len(payload.messages)}}


@router.post("/reset")
def reset_db(db: Session = Depends(get_db)):
    """DANGER: delete all rows. Use for testing."""
    db.query(Report).delete()
    db.query(Message).delete()
    db.query(Node).delete()
    db.query(User).delete()
    db.commit()
    return {"status": "reset", "detail": "all tables truncated"}


# ---------- fake inject ----------

class FakeHeartbeat(BaseModel):
    node: int = Field(ge=1, le=254)
    role: int = 1
    clients: int = 0
    path: list[int] = Field(default_factory=lambda: [1])
    uptime_s: int = 0
    tx: int = 0
    rx: int = 0
    battery: Optional[int] = None
    neighbors: list[dict] = Field(default_factory=list)

@router.post("/fake/heartbeat")
def fake_heartbeat(payload: FakeHeartbeat):
    # build serial_schema Heartbeat and pass through handler
    neighbors = [Neighbor(id=n.get("id",1), rssi=n.get("rssi",-70)) for n in payload.neighbors]
    pkt = HeartbeatPkt(
        type="heartbeat",
        node=payload.node,
        role=Role(payload.role),
        clients=payload.clients,
        path=payload.path,
        uptime_s=payload.uptime_s,
        tx=payload.tx,
        rx=payload.rx,
        battery=payload.battery,
        neighbors=neighbors,
    )
    handle_uplink(pkt, send_downlink=None)
    return {"status": "ok", "type": "heartbeat", "node": payload.node}


class FakeReport(BaseModel):
    msg_id: int
    attempt: int = 0
    origin: int = 1
    path: list[int] = Field(default_factory=lambda: [1])
    user_id: int = 1
    category: int = 1
    people: int = 1
    needs: int = 0
    name: str = "Test User"
    phone: str = "1234567890"
    location: str = "Test Location"
    message: str = "Help needed"
    gps_lat: Optional[float] = None
    gps_lon: Optional[float] = None
    gps_accuracy: Optional[int] = None

@router.post("/fake/report")
def fake_report(payload: FakeReport):
    from packets.serial_schema import Gps, Severity
    gps = None
    if payload.gps_lat is not None and payload.gps_lon is not None:
        gps = Gps(lat=payload.gps_lat, lon=payload.gps_lon, accuracy_m=payload.gps_accuracy or 10)
    # Wire schema still requires severity; ignored on persist (AI sets ai_priority).
    pkt = ReportPkt(
        type="report",
        msg_id=payload.msg_id,
        attempt=payload.attempt,
        origin=payload.origin,
        path=payload.path,
        user_id=payload.user_id,
        category=payload.category,
        severity=Severity.UNKNOWN,
        people=payload.people,
        needs=payload.needs,
        gps=gps,
        name=payload.name,
        phone=payload.phone,
        location=payload.location,
        message=payload.message,
    )
    handle_uplink(pkt, send_downlink=None)
    return {"status": "ok", "type": "report", "msg_id": payload.msg_id}


class FakeUserReply(BaseModel):
    msg_id: int
    attempt: int = 0
    origin: int = 1
    path: list[int] = Field(default_factory=lambda: [1])
    user_id: int = 1
    reply_to: int = 0
    text: str = "User reply"

@router.post("/fake/user_reply")
def fake_user_reply(payload: FakeUserReply):
    pkt = UserReplyPkt(
        type="user_reply",
        msg_id=payload.msg_id,
        attempt=payload.attempt,
        origin=payload.origin,
        path=payload.path,
        user_id=payload.user_id,
        reply_to=payload.reply_to,
        text=payload.text,
    )
    handle_uplink(pkt, send_downlink=None)
    return {"status": "ok", "type": "user_reply", "msg_id": payload.msg_id}


@router.post("/seed_random")
def seed_random(count: int = 5, db: Session = Depends(get_db)):
    """Quickly seed N random rows for demo/testing."""
    now = datetime.now(timezone.utc)
    created = {"users":0, "nodes":0, "reports":0, "messages":0}
    # users
    for i in range(count):
        uid = random.randint(1000, 9999)
        if not db.get(User, uid):
            db.add(User(user_id=uid, name=f"User {uid}", phone=f"555{uid}", first_seen=now, last_seen=now))
            created["users"]+=1
    db.flush()
    # nodes
    for i in range(count):
        nid = random.randint(10, 50)
        if not db.get(Node, nid):
            db.add(Node(node_id=nid, role=random.choice([1,2]), status="online", clients=random.randint(0,5), path=[nid,9], uptime_s=random.randint(0,10000), tx=random.randint(0,100), rx=random.randint(0,100), battery=random.randint(20,100), neighbors=[{"id": random.randint(1,9), "rssi": -70}], last_seen=now))
            created["nodes"]+=1
    db.flush()
    # reports
    user_ids = [u.user_id for u in db.query(User).all()] or [1]
    for i in range(count):
        msg_id = random.randint(100000, 999999)
        if db.query(Report).filter(Report.msg_id==msg_id).first():
            continue
        uid = random.choice(user_ids)
        db.add(Report(msg_id=msg_id, attempt=0, user_id=uid, origin=random.randint(1,5), path=[random.randint(1,5),9], category=random.randint(1,8), people=random.randint(1,5), needs=random.randint(0,255), location=f"Area {random.randint(1,99)}", message=f"Emergency {msg_id}", status="received", created_at=now, acked_at=now))
        created["reports"]+=1
    # messages
    for i in range(count):
        db.add(Message(msg_id=None, direction=random.choice(["uplink","downlink"]), user_id=random.choice(user_ids), reply_to=0, target_node=random.randint(1,9), path=[1,9], sender="Responder", text=f"Message {i}", status="pending", created_at=now))
        created["messages"]+=1
    db.commit()
    return {"status":"seeded", **created}
