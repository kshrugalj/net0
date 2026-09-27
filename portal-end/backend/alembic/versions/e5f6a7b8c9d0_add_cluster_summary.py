"""add cluster summary and responders to reports

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, Sequence[str], None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("reports", sa.Column("cluster_summary", sa.String(length=600), nullable=True))
    op.add_column("reports", sa.Column("cluster_responders", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "cluster_responders")
    op.drop_column("reports", "cluster_summary")
