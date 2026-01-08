"""
Create bookmarks table in database
"""
import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from models import Base, Bookmark
import os

async def create_bookmarks_table():
    # Get database URL from environment
    database_url = os.getenv('DATABASE_URL', 'postgresql://lct_user:lct_password@localhost:5433/lct_dev')

    # Convert to async driver
    if database_url.startswith('postgresql://'):
        database_url = database_url.replace('postgresql://', 'postgresql+asyncpg://')

    # Create async engine
    engine = create_async_engine(database_url, echo=True)

    # Create table
    async with engine.begin() as conn:
        # Only create bookmarks table, not all tables
        await conn.run_sync(Bookmark.__table__.create, checkfirst=True)

    print("✅ Bookmarks table created successfully!")

    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(create_bookmarks_table())
