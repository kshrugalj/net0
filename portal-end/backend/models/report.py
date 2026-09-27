from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base
from packets.serial_schema import LOCATION_MAX, REPORT_MSG_MAX


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (UniqueConstraint("msg_id", name="uq_reports_msg_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    msg_id: Mapped[int] = mapped_column(Integer, index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=0)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.user_id"), index=True
    )
    origin: Mapped[int] = mapped_column(Integer)
    path: Mapped[list] = mapped_column(JSON)

    category: Mapped[int] = mapped_column(Integer)
    people: Mapped[int] = mapped_column(Integer, default=0)
    needs: Mapped[int] = mapped_column(Integer, default=0)

    gps_lat: Mapped[float | None] = mapped_column(nullable=True)
    gps_lon: Mapped[float | None] = mapped_column(nullable=True)
    gps_accuracy: Mapped[int | None] = mapped_column(Integer, nullable=True)

    location: Mapped[str] = mapped_column(String(LOCATION_MAX))
    message: Mapped[str] = mapped_column(String(REPORT_MSG_MAX), default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    acked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    status: Mapped[str] = mapped_column(String(16), default="received")
    # Kept in the database after dispatch. Open views, clustering, and summaries skip these.
    resolved: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false(), index=True
    )
    ai_priority: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ai_category: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ai_summary: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    ai_responders: Mapped[list | None] = mapped_column(JSON, nullable=True)
    cluster_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    cluster_summary: Mapped[str | None] = mapped_column(String(600), nullable=True)
    cluster_responders: Mapped[list | None] = mapped_column(JSON, nullable=True)

    user: Mapped["User"] = relationship(back_populates="reports")
