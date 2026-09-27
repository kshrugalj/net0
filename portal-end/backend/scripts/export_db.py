#!/usr/bin/env python3
"""
Export local SQLite (portal.db) to seed_data.json.

Usage:
  python scripts/export_db.py              # -> seed_data.json (default ../seed_data.json and ./seed_data.json)
  python scripts/export_db.py --out my.json
  python scripts/export_db.py --dump-sql  # also creates seed.sql

Teammate share workflow:
  1. You change data locally, run this script.
  2. Commit seed_data.json (and optionally seed.sql) to git.
  3. Teammate pulls and runs: python scripts/seed_db.py
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# ensure backend on path
BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from database import SessionLocal
from models.user import User
from models.report import Report
from models.node import Node
from models.message import Message


def export_json():
    db = SessionLocal()
    try:
        users = db.query(User).all()
        reports = db.query(Report).all()
        nodes = db.query(Node).all()
        messages = db.query(Message).all()

        def ser_user(u):
            return {
                "user_id": u.user_id,
                "name": u.name,
                "phone": u.phone,
                "first_seen": u.first_seen.isoformat() if u.first_seen else None,
                "last_seen": u.last_seen.isoformat() if u.last_seen else None,
            }

        def ser_report(r):
            return {
                "id": r.id,
                "msg_id": r.msg_id,
                "attempt": r.attempt,
                "user_id": r.user_id,
                "origin": r.origin,
                "path": r.path,
                "category": r.category,
                "people": r.people,
                "needs": r.needs,
                "gps_lat": r.gps_lat,
                "gps_lon": r.gps_lon,
                "gps_accuracy": r.gps_accuracy,
                "location": r.location,
                "message": r.message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "acked_at": r.acked_at.isoformat() if r.acked_at else None,
                "status": r.status,
                "resolved": bool(r.resolved),
                "ai_priority": r.ai_priority,
                "ai_category": r.ai_category,
                "ai_summary": r.ai_summary,
                "ai_responders": r.ai_responders,
            }

        def ser_node(n):
            return {
                "node_id": n.node_id,
                "role": n.role,
                "status": n.status,
                "clients": n.clients,
                "path": n.path,
                "uptime_s": n.uptime_s,
                "tx": n.tx,
                "rx": n.rx,
                "battery": n.battery,
                "neighbors": n.neighbors,
                "last_seen": n.last_seen.isoformat() if n.last_seen else None,
            }

        def ser_msg(m):
            return {
                "id": m.id,
                "msg_id": m.msg_id,
                "direction": m.direction,
                "user_id": m.user_id,
                "reply_to": m.reply_to,
                "target_node": m.target_node,
                "path": m.path,
                "sender": m.sender,
                "text": m.text,
                "status": m.status,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }

        data = {
            "users": [ser_user(u) for u in users],
            "reports": [ser_report(r) for r in reports],
            "nodes": [ser_node(n) for n in nodes],
            "messages": [ser_msg(m) for m in messages],
        }
        return data
    finally:
        db.close()


def dump_sql(out_path: Path):
    db_path = BACKEND_DIR / "portal.db"
    if not db_path.exists():
        print(f"no portal.db at {db_path}, skipping sql dump")
        return
    con = sqlite3.connect(str(db_path))
    sql = "\n".join(con.iterdump())
    con.close()
    out_path.write_text(sql)
    print(f"wrote {out_path} ({len(sql)} bytes)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None, help="output json path (default: backend/data/seed_data.json)")
    ap.add_argument("--dump-sql", action="store_true", help="also dump seed.sql")
    args = ap.parse_args()

    data = export_json()
    out = Path(args.out) if args.out else BACKEND_DIR / "data" / "seed_data.json"
    out.write_text(json.dumps(data, indent=2))
    print(f"wrote {out} — users:{len(data['users'])} reports:{len(data['reports'])} nodes:{len(data['nodes'])} messages:{len(data['messages'])}")

    # also copy to repo root for visibility? optional
    # ensure git doesn't ignore it (it's not in .gitignore)
    if args.dump_sql:
        dump_sql(BACKEND_DIR / "seed.sql")

    # also export via API hint
    print("commit seed_data.json and push — teammate runs: python scripts/seed_db.py")


if __name__ == "__main__":
    main()
