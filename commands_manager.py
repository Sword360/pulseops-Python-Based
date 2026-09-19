# -*- coding: utf-8 -*-
"""
PulseOps Enterprise — Real-Time Linux Infrastructure Management
==============================================================================
Module:       commands_manager.py
Description:  Saved Commands & Terminal Runbooks Module.
              Provides persistent storage, RBAC filtering, parameter interpolation,
              and multi-server execution of operational runbook scripts.

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

import json
import logging
from typing import Dict, Any, List, Optional
import database
import terminal

logger = logging.getLogger("pulseops.commands")

DEFAULT_RUNBOOKS = [
    {
        "name": "Drop PageCache & Inodes",
        "description": "Free up memory pagecache, dentries and inodes cleanly.",
        "command": "sync && echo 3 > /proc/sys/vm/drop_caches",
        "requires_sudo": 1,
        "allowed_roles": json.dumps(["admin", "operator"])
    },
    {
        "name": "Docker System Prune",
        "description": "Remove all unused containers, networks, and dangling images.",
        "command": "docker system prune -f",
        "requires_sudo": 1,
        "allowed_roles": json.dumps(["admin", "operator"])
    },
    {
        "name": "Top 10 Memory Consuming Processes",
        "description": "List top 10 processes consuming the most resident memory (RSS).",
        "command": "ps aux --sort=-%mem | head -n 11",
        "requires_sudo": 0,
        "allowed_roles": json.dumps(["admin", "operator", "viewer"])
    },
    {
        "name": "Top 10 CPU Consuming Processes",
        "description": "List top 10 processes consuming the most CPU percentage.",
        "command": "ps aux --sort=-%cpu | head -n 11",
        "requires_sudo": 0,
        "allowed_roles": json.dumps(["admin", "operator", "viewer"])
    },
    {
        "name": "List Failed Systemd Units",
        "description": "Inspect all systemd services that entered a failed state.",
        "command": "systemctl --failed",
        "requires_sudo": 0,
        "allowed_roles": json.dumps(["admin", "operator", "viewer"])
    },
    {
        "name": "Disk Inodes Usage Summary",
        "description": "Report filesystem disk space and inode consumption.",
        "command": "df -hT && echo '--- INODES ---' && df -i",
        "requires_sudo": 0,
        "allowed_roles": json.dumps(["admin", "operator", "viewer"])
    },
    {
        "name": "Recent Failed SSH Logins",
        "description": "Audit recent failed authentication attempts from journalctl / auth.log.",
        "command": "journalctl -u ssh -u sshd -n 30 --no-pager | grep -i 'failed\\|invalid' || grep 'Failed password' /var/log/auth.log | tail -n 25",
        "requires_sudo": 1,
        "allowed_roles": json.dumps(["admin", "operator"])
    },
    {
        "name": "Check Open TCP/UDP Sockets",
        "description": "Display active listening TCP and UDP sockets with process info.",
        "command": "ss -tulpn",
        "requires_sudo": 0,
        "allowed_roles": json.dumps(["admin", "operator", "viewer"])
    }
]


async def seed_default_commands_if_needed() -> None:
    """Populate default sysadmin runbooks if the table is currently empty."""
    try:
        count_row = await database.fetchone("SELECT COUNT(*) as count FROM saved_commands")
        if count_row and count_row.get("count", 0) == 0:
            for rb in DEFAULT_RUNBOOKS:
                await database.execute(
                    """INSERT INTO saved_commands (name, description, command, requires_sudo, allowed_roles, created_by)
                       VALUES (?, ?, ?, ?, ?, 1)""",
                    (rb["name"], rb["description"], rb["command"], rb["requires_sudo"], rb["allowed_roles"])
                )
            logger.info("[Commands] Seeded default operational runbooks into database.")
    except Exception as e:
        logger.warning(f"[Commands] Could not seed default commands: {e}")


async def list_commands(user_role: str = "viewer") -> List[Dict[str, Any]]:
    """Return all saved commands accessible to the user's role."""
    await seed_default_commands_if_needed()
    try:
        rows = await database.fetchall("SELECT * FROM saved_commands ORDER BY id ASC")
        result = []
        for r in rows:
            roles_raw = r.get("allowed_roles") or '["admin"]'
            try:
                allowed = json.loads(roles_raw) if isinstance(roles_raw, str) else roles_raw
            except Exception:
                allowed = ["admin"]

            can_execute = user_role in allowed or user_role == "admin"
            result.append({
                "id": r["id"],
                "name": r["name"],
                "description": r.get("description", ""),
                "command": r["command"],
                "requires_sudo": bool(r.get("requires_sudo", 0)),
                "allowed_roles": allowed,
                "can_execute": can_execute,
                "created_by": r.get("created_by")
            })
        return result
    except Exception as e:
        logger.error(f"[Commands] Error listing commands: {e}")
        return []


async def get_command(command_id: int) -> Optional[Dict[str, Any]]:
    """Retrieve a single saved command by ID."""
    row = await database.fetchone("SELECT * FROM saved_commands WHERE id = ?", (command_id,))
    if not row:
        return None
    roles_raw = row.get("allowed_roles") or '["admin"]'
    try:
        allowed = json.loads(roles_raw) if isinstance(roles_raw, str) else roles_raw
    except Exception:
        allowed = ["admin"]
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row.get("description", ""),
        "command": row["command"],
        "requires_sudo": bool(row.get("requires_sudo", 0)),
        "allowed_roles": allowed,
        "created_by": row.get("created_by")
    }


async def create_command(name: str, description: str, command: str, requires_sudo: bool, allowed_roles: List[str], created_by: int = 1) -> Dict[str, Any]:
    """Create a new saved runbook command."""
    if not name or not command:
        return {"success": False, "error": "Name and command are required"}

    roles_json = json.dumps(allowed_roles or ["admin", "operator"])
    new_id = await database.execute(
        """INSERT INTO saved_commands (name, description, command, requires_sudo, allowed_roles, created_by)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (name, description or "", command, 1 if requires_sudo else 0, roles_json, created_by)
    )
    return {"success": True, "id": new_id, "message": "Command created successfully"}


async def update_command(command_id: int, name: str, description: str, command: str, requires_sudo: bool, allowed_roles: List[str]) -> Dict[str, Any]:
    """Update an existing saved command."""
    existing = await get_command(command_id)
    if not existing:
        return {"success": False, "error": "Command not found"}

    roles_json = json.dumps(allowed_roles or ["admin", "operator"])
    await database.execute(
        """UPDATE saved_commands SET name = ?, description = ?, command = ?, requires_sudo = ?, allowed_roles = ?
           WHERE id = ?""",
        (name, description or "", command, 1 if requires_sudo else 0, roles_json, command_id)
    )
    return {"success": True, "message": "Command updated successfully"}


async def delete_command(command_id: int) -> Dict[str, Any]:
    """Delete a saved command."""
    existing = await get_command(command_id)
    if not existing:
        return {"success": False, "error": "Command not found"}

    await database.execute("DELETE FROM saved_commands WHERE id = ?", (command_id,))
    return {"success": True, "message": "Command deleted successfully"}
