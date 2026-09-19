# -*- coding: utf-8 -*-
"""
PulseOps Enterprise — Real-Time Linux Infrastructure Management
==============================================================================
Module:       maintenance_manager.py
Description:  Maintenance Windows & Server Groups Module.
              Provides planned downtime scheduling to suppress alert dispatches during
              maintenance, environment grouping/tagging (Production, Staging), and SQLite database
              vacuum and optimization operations.

Author:       Najmul Islam
Developer:    Najmul Islam
Contact:      f2pnajmul@gmail.com
License:      MIT License (see LICENSE file for details)
Copyright:    (c) 2026 Najmul Islam. All rights reserved.
==============================================================================
"""

__author__ = "Najmul Islam"
__developer__ = "Najmul Islam"
__email__ = "f2pnajmul@gmail.com"
__license__ = "MIT"
__copyright__ = "(c) 2026 Najmul Islam. All rights reserved."

import logging
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
import database

logger = logging.getLogger("pulseops.maintenance")

DEFAULT_GROUPS = [
    {"id": "production", "name": "Production", "color": "#ef4444", "description": "Mission-critical live production nodes."},
    {"id": "staging", "name": "Staging", "color": "#f59e0b", "description": "Pre-release testing and validation environments."},
    {"id": "database", "name": "Database Cluster", "color": "#8b5cf6", "description": "Persistent state, SQL & NoSQL instances."},
    {"id": "edge", "name": "Edge / Ingress", "color": "#00f2fe", "description": "Edge gateways, reverse proxies, and load balancers."}
]


async def seed_default_groups_if_needed() -> None:
    """Seed standard environment server groups if empty."""
    try:
        count_row = await database.fetchone("SELECT COUNT(*) as count FROM server_groups")
        if count_row and count_row.get("count", 0) == 0:
            for g in DEFAULT_GROUPS:
                await database.execute(
                    "INSERT INTO server_groups (id, name, color, description) VALUES (?, ?, ?, ?)",
                    (g["id"], g["name"], g["color"], g["description"])
                )
            logger.info("[Maintenance] Seeded default server groups.")
    except Exception as e:
        logger.warning(f"[Maintenance] Could not seed default groups: {e}")


async def list_server_groups() -> List[Dict[str, Any]]:
    """Return all server groups."""
    await seed_default_groups_if_needed()
    try:
        return await database.fetchall("SELECT * FROM server_groups ORDER BY name ASC")
    except Exception as e:
        logger.error(f"[Maintenance] Error listing server groups: {e}")
        return []


async def create_server_group(group_id: str, name: str, color: str, description: str) -> Dict[str, Any]:
    """Create a new server group."""
    if not group_id or not name:
        return {"success": False, "error": "Group ID and name are required"}

    existing = await database.fetchone("SELECT id FROM server_groups WHERE id = ?", (group_id,))
    if existing:
        return {"success": False, "error": "Group ID already exists"}

    await database.execute(
        "INSERT INTO server_groups (id, name, color, description) VALUES (?, ?, ?, ?)",
        (group_id, name, color or "#00f2fe", description or "")
    )
    return {"success": True, "message": "Server group created successfully"}


async def delete_server_group(group_id: str) -> Dict[str, Any]:
    """Delete a server group."""
    await database.execute("DELETE FROM server_groups WHERE id = ?", (group_id,))
    return {"success": True, "message": "Server group deleted"}


async def list_maintenance_windows(server_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """List maintenance windows, optionally filtered by server_id."""
    try:
        if server_id:
            query = "SELECT * FROM maintenance_windows WHERE server_id = ? ORDER BY start_time DESC"
            rows = await database.fetchall(query, (server_id,))
        else:
            query = "SELECT * FROM maintenance_windows ORDER BY start_time DESC"
            rows = await database.fetchall(query)

        now_iso = datetime.now(timezone.utc).isoformat()
        res = []
        for r in rows:
            st = r.get("start_time", "")
            et = r.get("end_time", "")
            is_active = (st <= now_iso <= et) if (st and et) else False
            is_past = (et < now_iso) if et else False
            res.append({
                "id": r["id"],
                "server_id": r["server_id"],
                "start_time": st,
                "end_time": et,
                "reason": r.get("reason", ""),
                "created_by": r.get("created_by"),
                "is_active": is_active,
                "is_past": is_past
            })
        return res
    except Exception as e:
        logger.error(f"[Maintenance] Error listing maintenance windows: {e}")
        return []


async def is_server_in_maintenance(server_id: str) -> bool:
    """Check if server has an ongoing maintenance window right now."""
    if not server_id:
        return False
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        row = await database.fetchone(
            """SELECT id FROM maintenance_windows
               WHERE server_id = ? AND start_time <= ? AND end_time >= ?
               LIMIT 1""",
            (server_id, now_iso, now_iso)
        )
        return row is not None
    except Exception:
        return False


async def create_maintenance_window(server_id: str, start_time: str, end_time: str, reason: str, created_by: int = 1) -> Dict[str, Any]:
    """Schedule a new maintenance window."""
    if not server_id or not start_time or not end_time:
        return {"success": False, "error": "server_id, start_time, and end_time are required"}

    new_id = await database.execute(
        """INSERT INTO maintenance_windows (server_id, start_time, end_time, reason, created_by)
           VALUES (?, ?, ?, ?, ?)""",
        (server_id, start_time, end_time, reason or "Scheduled Maintenance", created_by)
    )
    return {"success": True, "id": new_id, "message": "Maintenance window scheduled"}


async def delete_maintenance_window(window_id: int) -> Dict[str, Any]:
    """Delete a maintenance window."""
    await database.execute("DELETE FROM maintenance_windows WHERE id = ?", (window_id,))
    return {"success": True, "message": "Maintenance window deleted"}
