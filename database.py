"""
database.py — PulseOps Enterprise SQLite Async Database Layer.

Manages connection pooling via aiosqlite, schema creation, and idempotent
migrations. All SQL uses parameterized queries exclusively to prevent injection.
"""

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

try:
    import aiosqlite
    AIOSQLITE_AVAILABLE = True
except ImportError:
    AIOSQLITE_AVAILABLE = False
    logging.warning("[DB] aiosqlite not installed — database features disabled. Run: pip install aiosqlite")

DB_PATH = os.environ.get("DB_PATH", "./pulseops.db")
_db_lock = asyncio.Lock()
_connection: Optional[Any] = None

logger = logging.getLogger("pulseops.db")


SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_login TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    failed_login_count INTEGER DEFAULT 0,
    locked_until TEXT,
    totp_secret TEXT,
    totp_enabled INTEGER DEFAULT 0,
    totp_backup_codes TEXT
);

CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    display_name TEXT,
    host_ip TEXT NOT NULL,
    agent_port INTEGER DEFAULT 3500,
    agent_token TEXT UNIQUE NOT NULL,
    os_info TEXT,
    arch TEXT,
    tags TEXT DEFAULT '[]',
    group_id TEXT,
    status TEXT DEFAULT 'unreachable',
    added_by INTEGER REFERENCES users(id),
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT,
    notes TEXT,
    maintenance_until TEXT
);

CREATE TABLE IF NOT EXISTS invite_tokens (
    token TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    used_by_server TEXT REFERENCES servers(id)
);

CREATE TABLE IF NOT EXISTS server_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    timestamp TEXT NOT NULL,
    cpu_percent REAL,
    mem_percent REAL,
    disk_percent REAL,
    net_rx_sec INTEGER,
    net_tx_sec INTEGER,
    load_avg_1 REAL,
    uptime INTEGER
);

CREATE INDEX IF NOT EXISTS idx_snapshots_server_time ON server_snapshots(server_id, timestamp);

CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    server_id TEXT,
    metric TEXT NOT NULL,
    operator TEXT NOT NULL,
    threshold REAL,
    severity TEXT NOT NULL DEFAULT 'warning',
    is_active INTEGER DEFAULT 1,
    notify_email INTEGER DEFAULT 0,
    notify_webhook INTEGER DEFAULT 0,
    webhook_url TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS active_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER REFERENCES alert_rules(id),
    server_id TEXT REFERENCES servers(id),
    fired_at TEXT NOT NULL,
    resolved_at TEXT,
    details TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER REFERENCES users(id),
    user_email TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details TEXT,
    ip_address TEXT,
    result TEXT NOT NULL DEFAULT 'success'
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    type TEXT DEFAULT 'string',
    updated_at TEXT,
    updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS server_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    description TEXT
);

CREATE TABLE IF NOT EXISTS saved_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    command TEXT NOT NULL,
    requires_sudo INTEGER DEFAULT 0,
    allowed_roles TEXT DEFAULT '["admin"]',
    created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS maintenance_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    reason TEXT,
    created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS token_blacklist (
    jti TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = [
    ("app_name", "PulseOps Enterprise", "string"),
    ("session_timeout_hours", "8", "int"),
    ("agent_poll_interval", "30", "int"),
    ("snapshot_retention_hours", "12", "int"),
    ("require_2fa", "false", "bool"),
    ("smtp_host", "", "string"),
    ("smtp_port", "587", "int"),
    ("smtp_username", "", "string"),
    ("smtp_password", "", "string"),
    ("smtp_from", "PulseOps Alerts <noreply@pulseops.local>", "string"),
    ("global_cpu_alert_threshold", "85", "int"),
    ("global_mem_alert_threshold", "90", "int"),
    ("global_disk_alert_threshold", "90", "int"),
    ("master_url", "", "string"),
]


async def get_db() -> Any:
    """Return the shared aiosqlite connection, creating it if needed.

    Returns:
        Active aiosqlite database connection.
    """
    global _connection
    if not AIOSQLITE_AVAILABLE:
        raise RuntimeError("aiosqlite is not installed")
    if _connection is None:
        async with _db_lock:
            if _connection is None:
                _connection = await aiosqlite.connect(DB_PATH)
                _connection.row_factory = aiosqlite.Row
                await _connection.execute("PRAGMA journal_mode=WAL")
                await _connection.execute("PRAGMA foreign_keys=ON")
    return _connection


async def init_db() -> None:
    """Initialize the database schema idempotently.

    Creates all tables, indexes, and populates default settings if missing.
    Safe to call on every startup — uses CREATE IF NOT EXISTS throughout.
    """
    if not AIOSQLITE_AVAILABLE:
        logger.warning("Skipping DB init — aiosqlite not available")
        return

    db = await get_db()
    async with db.executescript(SCHEMA_SQL):
        pass
    await db.commit()

    # Insert default settings (skip if already present)
    for key, value, dtype in DEFAULT_SETTINGS:
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value, type) VALUES (?, ?, ?)",
            (key, value, dtype)
        )
    await db.commit()
    logger.info("[DB] Schema initialized at %s", DB_PATH)


async def fetchone(query: str, params: Tuple = ()) -> Optional[Dict[str, Any]]:
    """Execute a SELECT and return the first row as a dict, or None.

    Args:
        query: Parameterized SQL query string.
        params: Tuple of query parameters.

    Returns:
        Row as dict or None if not found.
    """
    db = await get_db()
    async with db.execute(query, params) as cursor:
        row = await cursor.fetchone()
        if row is None:
            return None
        return dict(row)


async def fetchall(query: str, params: Tuple = ()) -> List[Dict[str, Any]]:
    """Execute a SELECT and return all rows as a list of dicts.

    Args:
        query: Parameterized SQL query string.
        params: Tuple of query parameters.

    Returns:
        List of rows as dicts.
    """
    db = await get_db()
    async with db.execute(query, params) as cursor:
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def execute(query: str, params: Tuple = ()) -> int:
    """Execute an INSERT/UPDATE/DELETE and return lastrowid or rowcount.

    Args:
        query: Parameterized SQL query string.
        params: Tuple of query parameters.

    Returns:
        Last inserted row ID (for INSERT) or 0.
    """
    db = await get_db()
    async with db.execute(query, params) as cursor:
        await db.commit()
        return cursor.lastrowid or 0


async def get_setting(key: str, default: str = "") -> str:
    """Retrieve a settings value by key.

    Args:
        key: Settings key name.
        default: Default value if not found.

    Returns:
        Setting value as string.
    """
    row = await fetchone("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else default


async def set_setting(key: str, value: str, user_id: Optional[int] = None) -> None:
    """Persist a settings value.

    Args:
        key: Settings key name.
        value: New value to store.
        user_id: ID of user making the change (for audit).
    """
    await execute(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
        (key, value, user_id)
    )


async def cleanup_expired_tokens() -> None:
    """Remove expired JWT blacklist entries to keep the table small."""
    await execute(
        "DELETE FROM token_blacklist WHERE expires_at < datetime('now')"
    )


async def cleanup_old_snapshots() -> None:
    """Delete telemetry snapshots older than the retention window."""
    retention_hours = int(await get_setting("snapshot_retention_hours", "12"))
    await execute(
        f"DELETE FROM server_snapshots WHERE timestamp < datetime('now', '-{retention_hours} hours')"
    )
