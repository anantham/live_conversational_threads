"""
SQLAlchemy async session setup for Live Conversational Threads.
"""

import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import sessionmaker

# Get database URL from environment
DATABASE_URL = os.getenv("DATABASE_URL")

# Convert postgres:// to postgresql+asyncpg:// for SQLAlchemy async
if DATABASE_URL and DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# Create async engine
async_engine = create_async_engine(
    DATABASE_URL,
    echo=False,  # Set to True for SQL query logging
    future=True,
)

# Create async session factory
AsyncSessionLocal = async_sessionmaker(
    async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_async_session():
    """
    Dependency function to get database session.

    Usage in FastAPI endpoints:
        @router.post("/endpoint")
        async def my_endpoint(db: AsyncSession = Depends(get_async_session)):
            ...
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


def get_async_session_context():
    """
    Context manager for getting database session in background tasks.

    Usage in background tasks:
        async with get_async_session_context() as db:
            # Use db session
            ...
    """
    return AsyncSessionLocal()
