from datetime import datetime

from pydantic import BaseModel, ConfigDict

from schemas.user import UserOut


class ReportList(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    msg_id: int
    user_id: int
    category: int
    people: int
    needs: int
    location: str
    status: str
    resolved: bool = False
    ai_priority: int | None = None
    created_at: datetime
    acked_at: datetime | None = None
    ai_responders: list[str] | None = None
    cluster_id: str | None = None
    cluster_summary: str | None = None
    cluster_responders: list[str] | None = None


class ReportDetail(ReportList):
    attempt: int
    origin: int
    path: list[int]
    gps_lat: float | None = None
    gps_lon: float | None = None
    gps_accuracy: int | None = None
    message: str
    ai_category: int | None = None
    ai_summary: str | None = None
    user: UserOut
