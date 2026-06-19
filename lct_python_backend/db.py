from databases import Database
import os

DATABASE_URL = os.getenv("DATABASE_URL")

# ssl=False mirrors db_session.py's connect_args={"ssl": False}: on the Windows
# proactor event loop asyncpg's SSL negotiation path is broken, so a bare
# db.connect() to loopback Postgres can hang INDEFINITELY at startup
# ("Connecting to database..." with no progress). Loopback needs no SSL; forcing
# it off keeps asyncpg off the broken negotiation path. Without this the engine
# (db_session) was protected but this databases.Database object was not.
db = Database(DATABASE_URL, ssl=False)