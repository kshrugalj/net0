from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class AgentEvidence(BaseModel):
    label: str
    detail: str
    tone: Literal["confirmed", "warning", "unknown"]


class RoutePoint(BaseModel):
    lat: float
    lon: float
    label: str
    kind: Literal["responder", "waypoint", "civilian"]


class AgentRunIn(BaseModel):
    report_id: int | None = Field(default=None, ge=1)
    responder_lat: float | None = Field(default=None, ge=-90, le=90)
    responder_lon: float | None = Field(default=None, ge=-180, le=180)
    responder_route: list[RoutePoint] = Field(default_factory=list, max_length=100)


class RescuePlan(BaseModel):
    report_id: int
    cluster_id: str
    priority: int = Field(ge=1, le=5)
    title: str
    summary: str
    approach: str
    avoid: str
    confidence: Literal["HIGH", "MEDIUM", "LOW"]
    evidence: list[AgentEvidence]
    unknowns: list[str]
    draft: str = Field(max_length=400)
    route: list[RoutePoint] = Field(default_factory=list)
    route_label: str = "Preferred corridor"
    route_note: str = "Based on current responder and civilian GPS positions; verify access before entry."
    generated_at: datetime


class AgentBriefOut(BaseModel):
    report_count: int
    incident_count: int
    insight: str
    highlights: list[str]
    summary: str
    signals: list[str]
    verify: list[str]
    generated_at: datetime


class CheckInPreviewIn(BaseModel):
    report_id: int = Field(ge=1)


class CheckInSendIn(BaseModel):
    report_id: int = Field(ge=1)
    text: str = Field(min_length=1, max_length=400)
    approved: bool = False


class AgentRunOut(BaseModel):
    plan: RescuePlan | None = None
    brief: AgentBriefOut
    processed_reports: int
    status: Literal["ok", "fallback"]


class DispatcherNextIn(BaseModel):
    queued_report_ids: list[int] = Field(default_factory=list, max_length=100)
    suppressed_user_ids: list[int] = Field(default_factory=list, max_length=100)
    previous_action: str = Field(default="", max_length=200)


class DispatcherActionOut(BaseModel):
    thought: str
    type: Literal["focus", "queue", "dispatch", "message", "open_messages", "wait"]
    report_id: int | None = None
    report_ids: list[int] = Field(default_factory=list)
    user_id: int | None = None
    text: str | None = None
    fingerprint: str
    gemini_ok: bool = True


class DispatcherBoardOut(BaseModel):
    fingerprint: str
    unresolved_count: int
    pending_replies: int
