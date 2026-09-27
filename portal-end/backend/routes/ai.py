from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ai import prompts as prompt_store
from ai.process import (
    ProcessResult,
    apply_result_to_report,
    process_packet,
)
from database import get_db
from models.report import Report
from schemas.ai import (
    ProcessPacketIn,
    ProcessResultOut,
    PromptOut,
    PromptUpdate,
)
from ai.agent import build_brief, build_plan, ensure_report_ai, send_check_in
from ai.cluster import load_clusters
from ai.dispatcher import board_status, next_action
from ai.llm import gemini_configured
from schemas.agent import (
    AgentBriefOut,
    AgentRunIn,
    AgentRunOut,
    CheckInPreviewIn,
    CheckInSendIn,
    DispatcherActionOut,
    DispatcherBoardOut,
    DispatcherNextIn,
)

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.post("/process", response_model=ProcessResultOut)
def process(payload: ProcessPacketIn, db: Session = Depends(get_db)):
    """
    Run AI process on packet/report JSON.

    Returns ai_summary, ai_priority, ai_responders (and ai_category).
    While the LLM is unconfigured, status will be \"stub\".
    Set persist=true with msg_id to write results onto an existing report
    (only when status is ok).
    """
    data = payload.model_dump(
        exclude={"prompt_name", "include_prompt", "persist"}
    )

    try:
        result: ProcessResult = process_packet(
            data,
            prompt_name=payload.prompt_name,
            include_prompt=payload.include_prompt,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    if payload.persist:
        if payload.msg_id is None:
            raise HTTPException(
                status_code=400,
                detail="persist=true requires msg_id",
            )
        report = (
            db.query(Report)
            .filter(Report.msg_id == payload.msg_id)
            .first()
        )
        if report is None:
            raise HTTPException(
                status_code=404,
                detail=f"report msg_id={payload.msg_id} not found",
            )
        apply_result_to_report(report, result)
        db.commit()

    return result


@router.get("/prompts", response_model=list[str])
def list_prompts():
    return prompt_store.list_prompts()


@router.get("/prompts/{name}", response_model=PromptOut)
def get_prompt(name: str):
    try:
        content = prompt_store.load(name)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return PromptOut(name=name, content=content)


@router.put("/prompts/{name}", response_model=PromptOut)
def update_prompt(name: str, payload: PromptUpdate):
    prompt_store.save(name, payload.content)
    return PromptOut(name=name, content=payload.content)


@router.get("/dispatcher/board", response_model=DispatcherBoardOut)
def get_dispatcher_board(db: Session = Depends(get_db)):
    return board_status(db)


@router.post("/dispatcher/next", response_model=DispatcherActionOut)
def post_dispatcher_next(payload: DispatcherNextIn, db: Session = Depends(get_db)):
    return next_action(
        db,
        queued_report_ids=payload.queued_report_ids,
        suppressed_user_ids=payload.suppressed_user_ids,
        previous_action=payload.previous_action,
    )


@router.post("/agent/run", response_model=AgentRunOut)
def run_agent(payload: AgentRunIn, db: Session = Depends(get_db)):
    responder_position = (
        (payload.responder_lat, payload.responder_lon)
        if payload.responder_lat is not None and payload.responder_lon is not None
        else None
    )
    ensure_report_ai(db)
    groups = load_clusters(db)
    plan = build_plan(
        db,
        payload.report_id,
        responder_position,
        payload.responder_route,
        groups=groups,
        ensure_ai=False,
    )
    brief = build_brief(db, groups=groups, ensure_ai=False)
    return AgentRunOut(
        plan=plan,
        brief=brief,
        processed_reports=db.query(Report).filter(Report.resolved.is_(False)).count(),
        status="ok" if gemini_configured() and plan is not None else "fallback",
    )


@router.get("/brief", response_model=AgentBriefOut)
def get_agent_brief(db: Session = Depends(get_db)):
    return build_brief(db)


@router.get("/rescue-plan/{report_id}", response_model=AgentRunOut)
def get_rescue_plan(report_id: int, db: Session = Depends(get_db)):
    plan = build_plan(db, report_id)
    return AgentRunOut(
        plan=plan,
        brief=build_brief(db),
        processed_reports=db.query(Report).filter(Report.resolved.is_(False)).count(),
        status="ok" if gemini_configured() and plan is not None else "fallback",
    )


@router.post("/check-in/preview")
def preview_check_in(payload: CheckInPreviewIn, db: Session = Depends(get_db)):
    plan = build_plan(db, payload.report_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"report_id": payload.report_id, "text": plan.draft, "requires_approval": True}


@router.post("/check-in/send")
def send_agent_check_in(payload: CheckInSendIn, db: Session = Depends(get_db)):
    try:
        message = send_check_in(db, payload.report_id, payload.text, payload.approved)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"message_id": message.id, "status": message.status, "text": message.text}
