"""
audit.py — PulseOps Enterprise Audit Log Module.

Records all state-changing actions to a persistent audit trail and provides
filtered, paginated read access for the admin audit viewer.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("pulseops.audit")


async def log_action(
    action: str,
    user_id: Optional[int] = None,
    user_email: Optional[str] = None,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    ip_address: Optional[str] = None,
    result: str = "success",
) -> None:
    """Write a single audit log entry.

    Args:
        action: Short action identifier (e.g. 'user.create', 'service.restart').
        user_id: ID of the user performing the action.
        user_email: Email of the user (denormalised for fast reads).
        resource_type: Type of resource affected (user, server, service, process, etc.).
        resource_id: Identifier of the affected resource.
        details: Arbitrary additional context as a JSON-serialisable dict.
        ip_address: Originating client IP address.
        result: 'success' or 'failure'.
    """
    try:
        from database import execute
        details_json = json.dumps(details) if details else None
        await execute(
            "INSERT INTO audit_log (user_id, user_email, action, resource_type, resource_id, details, ip_address, result) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, user_email, action, resource_type, str(resource_id) if resource_id is not None else None,
             details_json, ip_address, result)
        )
    except Exception as e:
        logger.error("[Audit] Failed to write audit log entry (action=%s): %s", action, e)


async def get_audit_log(
    page: int = 1,
    page_size: int = 50,
    user_filter: Optional[str] = None,
    action_filter: Optional[str] = None,
    resource_type_filter: Optional[str] = None,
    result_filter: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> Dict[str, Any]:
    """Retrieve paginated audit log entries with optional filters.

    Args:
        page: Page number (1-indexed).
        page_size: Number of entries per page (max 200).
        user_filter: Filter by user email (partial match).
        action_filter: Filter by action string (partial match).
        resource_type_filter: Filter by resource type.
        result_filter: Filter by result ('success' or 'failure').
        date_from: ISO date string lower bound (inclusive).
        date_to: ISO date string upper bound (inclusive).

    Returns:
        Dict with 'entries' list, 'total', 'page', 'page_size'.
    """
    from database import fetchall, fetchone

    page_size = min(page_size, 200)
    offset = (page - 1) * page_size

    where_clauses = []
    params: list = []

    if user_filter:
        where_clauses.append("user_email LIKE ?")
        params.append(f"%{user_filter}%")
    if action_filter:
        where_clauses.append("action LIKE ?")
        params.append(f"%{action_filter}%")
    if resource_type_filter:
        where_clauses.append("resource_type = ?")
        params.append(resource_type_filter)
    if result_filter:
        where_clauses.append("result = ?")
        params.append(result_filter)
    if date_from:
        where_clauses.append("timestamp >= ?")
        params.append(date_from)
    if date_to:
        where_clauses.append("timestamp <= ?")
        params.append(date_to)

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    count_row = await fetchone(
        f"SELECT COUNT(*) as total FROM audit_log {where_sql}",
        tuple(params)
    )
    total = count_row["total"] if count_row else 0

    entries = await fetchall(
        f"SELECT id, timestamp, user_email, action, resource_type, resource_id, details, ip_address, result "
        f"FROM audit_log {where_sql} ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        tuple(params) + (page_size, offset)
    )

    # Parse details JSON for each entry
    for entry in entries:
        if entry.get("details"):
            try:
                entry["details"] = json.loads(entry["details"])
            except Exception:
                pass

    return {
        "entries": entries,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": (total + page_size - 1) // page_size if total > 0 else 1,
    }


async def get_recent_activity(limit: int = 20) -> List[Dict[str, Any]]:
    """Return the most recent audit log entries for the activity feed.

    Args:
        limit: Maximum number of entries to return.

    Returns:
        List of recent audit log entry dicts.
    """
    from database import fetchall
    entries = await fetchall(
        "SELECT id, timestamp, user_email, action, resource_type, resource_id, result "
        "FROM audit_log ORDER BY timestamp DESC LIMIT ?",
        (limit,)
    )
    return entries
