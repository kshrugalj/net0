"""add resolved flag to reports

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, Sequence[str], None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("resolved", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_reports_resolved", "reports", ["resolved"], unique=False)
    op.execute(
        "UPDATE reports SET resolved = 1 WHERE lower(status) IN ('resolved', 'closed')"
    )


def downgrade() -> None:
    op.drop_index("ix_reports_resolved", table_name="reports")
    op.drop_column("reports", "resolved")
