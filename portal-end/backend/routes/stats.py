from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func

from database import get_db
from models.user import User
from models.report import Report
from models.node import Node
from models.message import Message

router = APIRouter(prefix="/api", tags=["stats"])


@router.get("/stats")
def get_stats(db: Session = Depends(get_db)):
    users = db.query(func.count(User.user_id)).scalar()
    reports = db.query(func.count(Report.id)).filter(Report.resolved.is_(False)).scalar()
    nodes_total = db.query(func.count(Node.node_id)).scalar()
    nodes_online = db.query(func.count(Node.node_id)).filter(Node.status == "online").scalar()
    messages = db.query(func.count(Message.id)).scalar()
    # latest timestamps
    latest_report = (
        db.query(Report)
        .filter(Report.resolved.is_(False))
        .order_by(Report.created_at.desc())
        .first()
    )
    return {
        "users": users or 0,
        "reports": reports or 0,
        "nodes_total": nodes_total or 0,
        "nodes_online": nodes_online or 0,
        "nodes_offline": (nodes_total or 0) - (nodes_online or 0),
        "messages": messages or 0,
        "latest_report_at": latest_report.created_at.isoformat() if latest_report else None,
    }


@router.get("/health")
def health():
    return {"status": "online"}
