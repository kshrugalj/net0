#!/usr/bin/env python3
"""
Seed local SQLite from seed_data.json.

Usage:
  python scripts/seed_db.py                  # reads data/seed_data.json (merge mode)
  python scripts/seed_db.py --replace        # wipes tables first
  python scripts/seed_db.py --in my.json
  python scripts/seed_db.py --from-api       # fetch from running server http://localhost:8000/api/debug/export

Idempotent: merges on primary keys (user_id, node_id, msg_id). Safe to run multiple times.

Teammate workflow after git pull:
  alembic upgrade head   # if schema changed
  python scripts/seed_db.py
  # or: ./scripts/setup.sh
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from database import SessionLocal, Base, engine
from models.user import User
from models.report import Report
from models.node import Node, utcnow
from models.message import Message


def parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return datetime.now(timezone.utc)


def load_json(path: Path):
    return json.loads(path.read_text())


def seed(data, mode="merge"):
    db = SessionLocal()
    try:
        # ensure tables exist (for fresh clone without alembic)
        Base.metadata.create_all(bind=engine)

        if mode == "replace":
            print("replace mode: truncating tables...")
            db.query(Report).delete()
            db.query(Message).delete()
            db.query(Node).delete()
            db.query(User).delete()
            db.commit()

        # users
        for u in data.get("users", []):
            uid = u.get("user_id")
            if uid is None:
                continue
            existing = db.get(User, uid)
            if existing and mode != "replace":
                existing.name = u.get("name", existing.name)
                existing.phone = u.get("phone", existing.phone)
                continue
            user = User(
                user_id=uid,
                name=u.get("name", ""),
                phone=u.get("phone", ""),
                first_seen=parse_dt(u.get("first_seen")) or datetime.now(timezone.utc),
                last_seen=parse_dt(u.get("last_seen")) or datetime.now(timezone.utc),
            )
            db.merge(user)
        db.flush()

        # nodes
        for n in data.get("nodes", []):
            nid = n.get("node_id")
            if nid is None:
                continue
            # always refresh last_seen to now for online nodes so sweep doesn't immediately mark offline
            desired_last_seen = utcnow() if n.get("status") == "online" else (parse_dt(n.get("last_seen")) or utcnow())
            existing = db.get(Node, nid)
            if existing and mode != "replace":
                for k in ["role", "status", "clients", "path", "uptime_s", "tx", "rx", "battery", "neighbors"]:
                    if k in n:
                        setattr(existing, k, n[k])
                existing.last_seen = desired_last_seen
                continue
            node = Node(
                node_id=nid,
                role=n.get("role", 1),
                status=n.get("status", "offline"),
                clients=n.get("clients", 0),
                path=n.get("path"),
                uptime_s=n.get("uptime_s", 0),
                tx=n.get("tx", 0),
                rx=n.get("rx", 0),
                battery=n.get("battery"),
                neighbors=n.get("neighbors", []),
                last_seen=desired_last_seen,
            )
            db.merge(node)
        db.flush()

        # reports
        for r in data.get("reports", []):
            msg_id = r.get("msg_id")
            if msg_id is None:
                continue
            existing = db.query(Report).filter(Report.msg_id == msg_id).first()
            if existing and mode != "replace":
                continue
            uid = r.get("user_id")
            if uid and not db.get(User, uid):
                db.merge(User(user_id=uid, name="", phone="", first_seen=utcnow(), last_seen=utcnow()))
                db.flush()
            report = Report(
                msg_id=msg_id,
                attempt=r.get("attempt", 0),
                user_id=uid,
                origin=r.get("origin", 1),
                path=r.get("path", [1]),
                category=r.get("category", 0),
                people=r.get("people", 0),
                needs=r.get("needs", 0),
                gps_lat=r.get("gps_lat"),
                gps_lon=r.get("gps_lon"),
                gps_accuracy=r.get("gps_accuracy"),
                location=r.get("location", ""),
                message=r.get("message", ""),
                created_at=parse_dt(r.get("created_at")) or utcnow(),
                acked_at=parse_dt(r.get("acked_at")),
                status=r.get("status", "received"),
                resolved=bool(r.get("resolved", str(r.get("status", "")).lower() in {"resolved", "closed"})),
                ai_priority=r.get("ai_priority"),
                ai_category=r.get("ai_category"),
                ai_summary=r.get("ai_summary"),
                ai_responders=r.get("ai_responders"),
            )
            # handle explicit id if replace and provided
            if r.get("id") and mode == "replace":
                report.id = r["id"]
            db.add(report)
        db.flush()

        # messages
        for m in data.get("messages", []):
            mid = m.get("msg_id")
            if mid is not None:
                existing = db.query(Message).filter(Message.msg_id == mid).first()
                if existing and mode != "replace":
                    continue
            uid = m.get("user_id")
            if uid and not db.get(User, uid):
                db.merge(User(user_id=uid, name="", phone="", first_seen=utcnow(), last_seen=utcnow()))
                db.flush()
            msg = Message(
                msg_id=mid,
                direction=m.get("direction", "downlink"),
                user_id=uid,
                reply_to=m.get("reply_to", 0),
                target_node=m.get("target_node"),
                path=m.get("path"),
                sender=m.get("sender", ""),
                text=m.get("text", ""),
                status=m.get("status", "pending"),
                created_at=parse_dt(m.get("created_at")) or utcnow(),
            )
            db.add(msg)

        db.commit()
        print(f"seeded — users:{len(data.get('users',[]))} nodes:{len(data.get('nodes',[]))} reports:{len(data.get('reports',[]))} messages:{len(data.get('messages',[]))} (mode={mode})")
    except Exception as e:
        db.rollback()
        raise
    finally:
        db.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", default=None, help="input json (default: backend/data/seed_data.json)")
    ap.add_argument("--replace", action="store_true", help="wipe before seed")
    ap.add_argument("--from-api", action="store_true", help="fetch from http://localhost:8000/api/debug/export")
    ap.add_argument("--api-url", default="http://localhost:8000/api/debug/export")
    args = ap.parse_args()

    mode = "replace" if args.replace else "merge"

    if args.from_api:
        import urllib.request
        print(f"fetching {args.api_url} ...")
        with urllib.request.urlopen(args.api_url) as r:
            data = json.loads(r.read().decode())
        seed(data, mode=mode)
        return

    infile = Path(args.infile) if args.infile else BACKEND_DIR / "data" / "seed_data.json"
    if not infile.exists():
        print(f"no {infile} found — nothing to seed. Run scripts/export_db.py first or check API.")
        # also try to create empty template
        infile.write_text(json.dumps({"users":[],"reports":[],"nodes":[],"messages":[]}, indent=2))
        print(f"created empty {infile}")
        return
    data = load_json(infile)
    seed(data, mode=mode)


if __name__ == "__main__":
    main()
