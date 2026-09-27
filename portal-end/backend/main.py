import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from database import Base, engine
from sqlalchemy import inspect, text
from models import Message, Node, Report, User  # noqa: F401
from packets import esp_manager
from packets.packet_handler import mark_stale_nodes_offline

# routers
from routes import (
    ai_router,
    debug_router,
    messages_router,
    nodes_router,
    reports_router,
    stats_router,
    users_router,
)

# -- configuration --
# logging
logging.basicConfig(
    level=logging.INFO
)

logger = logging.getLogger(__name__)

# node status sweep
OFFLINE_SWEEP_INTERVAL = 5


def _ensure_report_columns() -> None:
    """Add newer report columns on existing SQLite DBs without a full migration."""
    try:
        inspector = inspect(engine)
        columns = {column["name"] for column in inspector.get_columns("reports")}
    except Exception:
        return
    statements: list[str] = []
    if "cluster_id" not in columns:
        statements.append("ALTER TABLE reports ADD COLUMN cluster_id VARCHAR(64)")
        statements.append("CREATE INDEX IF NOT EXISTS ix_reports_cluster_id ON reports (cluster_id)")
    added_resolved = "resolved" not in columns
    if "cluster_summary" not in columns:
        statements.append("ALTER TABLE reports ADD COLUMN cluster_summary VARCHAR(600)")
    if "cluster_responders" not in columns:
        statements.append("ALTER TABLE reports ADD COLUMN cluster_responders JSON")
    if added_resolved:
        statements.append(
            "ALTER TABLE reports ADD COLUMN resolved BOOLEAN NOT NULL DEFAULT 0"
        )
    if not statements and not added_resolved:
        return
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
        if added_resolved:
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_reports_resolved ON reports (resolved)"
                )
            )
            connection.execute(
                text(
                    "UPDATE reports SET resolved = 1 "
                    "WHERE lower(status) IN ('resolved', 'closed')"
                )
            )
    if statements:
        logger.info("Added missing report columns: %s", ", ".join(statements))


# -- fast api --
# lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):

    logger.info("Starting FastAPI backend...")

    # create sql tables
    Base.metadata.create_all(bind=engine)
    _ensure_report_columns()

    # Baseline clustering for existing reports (does not require Agent Mode).
    from ai.cluster import enqueue_baseline

    enqueue_baseline()

    # start bluetooth connection
    ble_task = asyncio.create_task(
        esp_manager.connect_to_esp32()
    )

    # mark nodes offline without heartbeats
    sweep_task = asyncio.create_task(
        _offline_sweep()
    )

    yield

    # stop bluetooth connection
    logger.info("Stopping FastAPI backend...")

    ble_task.cancel()
    sweep_task.cancel()

    for task in (ble_task, sweep_task):

        try:
            await task
        except asyncio.CancelledError:
            pass


async def _offline_sweep():

    while True:

        try:

            marked = await asyncio.to_thread(
                mark_stale_nodes_offline
            )

            if marked:
                logger.info(
                    f"Marked {marked} node(s) offline"
                )

        except Exception as e:

            logger.error(
                f"Offline sweep error: {e}"
            )

        await asyncio.sleep(
            OFFLINE_SWEEP_INTERVAL
        )


# app
app = FastAPI(
    title="net0 Portal",
    lifespan=lifespan
)

# -- CORS (for Vite dev if used; harmless for same-origin debug.html) --
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -- routers --
app.include_router(users_router)
app.include_router(nodes_router)
app.include_router(reports_router)
app.include_router(messages_router)
app.include_router(stats_router)
app.include_router(ai_router)

# debug routes guarded by env (default on for hackathon)
DEBUG = os.getenv("DEBUG", "1") != "0"
if DEBUG:
    app.include_router(debug_router)
else:
    logging.getLogger(__name__).info("DEBUG routes disabled (DEBUG=0)")

# -- static: debug.html --
STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(exist_ok=True)

# mount static dir if it has files (for future assets)
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root():
    return {"status": "online"}


@app.get("/debug", include_in_schema=False)
async def debug_page():
    idx = STATIC_DIR / "debug.html"
    if idx.exists():
        return FileResponse(str(idx))
    return {"detail": "debug.html not found — build step missing", "hint": "check portal-end/backend/static/debug.html"}
