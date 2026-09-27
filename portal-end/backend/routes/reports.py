from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
from models.report import Report
from models.user import User
from schemas.report import ReportDetail, ReportList

router = APIRouter(prefix="/api/reports", tags=["reports"])


class ReportCreate(BaseModel):
    msg_id: int = Field(ge=0, le=4294967295)
    attempt: int = 0
    user_id: int = Field(ge=1, le=65535)
    origin: int = Field(ge=1, le=254)
    path: list[int] = Field(default_factory=lambda: [1])
    category: int = 0
    people: int = 0
    needs: int = 0
    gps_lat: Optional[float] = None
    gps_lon: Optional[float] = None
    gps_accuracy: Optional[int] = None
    location: str = ""
    message: str = ""
    status: str = "received"
    ai_priority: Optional[int] = None
    ai_category: Optional[int] = None
    ai_summary: Optional[str] = None
    ai_responders: Optional[list[str]] = None

    # optional auto-create user fields
    name: str = ""
    phone: str = ""


class ReportUpdate(BaseModel):
    category: Optional[int] = None
    people: Optional[int] = None
    needs: Optional[int] = None
    gps_lat: Optional[float] = None
    gps_lon: Optional[float] = None
    gps_accuracy: Optional[int] = None
    location: Optional[str] = None
    message: Optional[str] = None
    status: Optional[str] = None
    resolved: Optional[bool] = None
    ai_priority: Optional[int] = None
    ai_category: Optional[int] = None
    ai_summary: Optional[str] = None
    ai_responders: Optional[list[str]] = None
    path: Optional[list[int]] = None
    origin: Optional[int] = None


def _ensure_user(db: Session, user_id: int, name: str = "", phone: str = ""):
    user = db.get(User, user_id)
    if not user:
        now = datetime.now(timezone.utc)
        user = User(user_id=user_id, name=name, phone=phone, first_seen=now, last_seen=now)
        db.add(user)
        db.flush()
    return user


@router.get("", response_model=list[ReportDetail])
def list_reports(
    user_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    sort: str = Query("created_at"),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    if sort == "priority":
        q = db.query(Report).order_by(Report.ai_priority.desc().nullslast(), Report.created_at.desc())
    else:
        q = db.query(Report).order_by(Report.created_at.desc())
    q = q.filter(Report.resolved.is_(False))
    if user_id is not None:
        q = q.filter(Report.user_id == user_id)
    if status is not None:
        q = q.filter(Report.status == status)
    return q.limit(limit).all()


@router.get("/{report_id}", response_model=ReportDetail)
def get_report(report_id: int, db: Session = Depends(get_db)):
    # report_id is primary key `id`, fallback to msg_id search for convenience
    report = db.get(Report, report_id)
    if not report:
        # try msg_id lookup
        report = db.query(Report).filter(Report.msg_id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@router.post("", response_model=ReportDetail, status_code=201)
def create_report(payload: ReportCreate, db: Session = Depends(get_db)):
    # dedup on msg_id
    existing = db.query(Report).filter(Report.msg_id == payload.msg_id).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"msg_id {payload.msg_id} already exists (id={existing.id})")
    user = _ensure_user(db, payload.user_id, payload.name, payload.phone)
    if user.origin is None:
        user.origin = payload.origin
    now = datetime.now(timezone.utc)
    report = Report(
        msg_id=payload.msg_id,
        attempt=payload.attempt,
        user_id=payload.user_id,
        origin=payload.origin,
        path=payload.path,
        category=payload.category,
        people=payload.people,
        needs=payload.needs,
        gps_lat=payload.gps_lat,
        gps_lon=payload.gps_lon,
        gps_accuracy=payload.gps_accuracy,
        location=payload.location,
        message=payload.message,
        status=payload.status,
        resolved=False,
        ai_priority=payload.ai_priority,
        ai_category=payload.ai_category,
        ai_summary=payload.ai_summary,
        ai_responders=payload.ai_responders,
        created_at=now,
        acked_at=now,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    from ai.cluster import enqueue_baseline

    enqueue_baseline(report.msg_id)
    return report


@router.patch("/{report_id}", response_model=ReportDetail)
def update_report(report_id: int, payload: ReportUpdate, db: Session = Depends(get_db)):
    report = db.get(Report, report_id)
    if not report:
        report = db.query(Report).filter(Report.msg_id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    data = payload.model_dump(exclude_unset=True)
    newly_resolved = data.get("resolved") is True and not report.resolved
    for k, v in data.items():
        setattr(report, k, v)
    if report.resolved:
        report.cluster_id = None
        report.cluster_summary = None
        report.cluster_responders = None
    db.commit()
    db.refresh(report)
    if newly_resolved:
        from ai.cluster import enqueue_recluster

        enqueue_recluster()
    return report


@router.delete("/{report_id}", status_code=204)
def delete_report(report_id: int, db: Session = Depends(get_db)):
    report = db.get(Report, report_id)
    if not report:
        report = db.query(Report).filter(Report.msg_id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    db.delete(report)
    db.commit()
    return None
