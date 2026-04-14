"""Merge multiple heads

Revision ID: fc20c9ad7b2e
Revises: speaker_audio_references, add_usage_quotas
Create Date: 2026-04-14 14:15:35.207235

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fc20c9ad7b2e'
down_revision: Union[str, Sequence[str], None] = ('speaker_audio_references', 'add_usage_quotas')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
