# -*- coding: utf-8 -*-
"""
PulseOps Enterprise — Real-Time Linux Infrastructure Management
==============================================================================
Module:       backup_manager.py
Description:  Enterprise Backup & Disaster Recovery Manager.
              Handles full and selective system configuration snapshots, database dumps,
              tar.gz compression, integrity verification (SHA256), manifest inspection,
              and retention lifecycle management.

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

import os
import re
import glob
import time
import shutil
import hashlib
import tarfile
import sqlite3
import asyncio
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timezone

logger = logging.getLogger("pulseops.backups")

DB_PATH = os.environ.get("DB_PATH", "./pulseops.db")

# Backup storage location
DEFAULT_BACKUP_DIR = "/var/backups/pulseops"
FALLBACK_BACKUP_DIR = os.path.abspath("./backups/pulseops")


def _get_backup_dir() -> str:
    """Ensure writable backup directory exists, falling back to local workspace if needed."""
    try:
        os.makedirs(DEFAULT_BACKUP_DIR, exist_ok=True)
        test_file = os.path.join(DEFAULT_BACKUP_DIR, ".write_test")
        with open(test_file, "w") as f:
            f.write("test")
        os.remove(test_file)
        return DEFAULT_BACKUP_DIR
    except Exception:
        os.makedirs(FALLBACK_BACKUP_DIR, exist_ok=True)
        return FALLBACK_BACKUP_DIR


def _get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            filename TEXT NOT NULL,
            filepath TEXT NOT NULL,
            backup_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            file_count INTEGER DEFAULT 0,
            checksum TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            created_by TEXT NOT NULL DEFAULT 'admin',
            status TEXT NOT NULL DEFAULT 'completed',
            notes TEXT
        );
    """)
    conn.commit()
    return conn


def _calc_sha256(filepath: str) -> str:
    """Calculate SHA256 checksum of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


# ─── Core Backup Operations ──────────────────────────────────────────────────

def list_backups_sync() -> Dict[str, Any]:
    """List all stored backups and summary storage metrics."""
    conn = _get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM backups ORDER BY id DESC")
    rows = cur.fetchall()

    backups = []
    total_bytes = 0

    for r in rows:
        b_dict = dict(r)
        # Check if file still exists on disk
        fpath = b_dict.get("filepath", "")
        file_exists = os.path.isfile(fpath)
        b_dict["file_exists"] = file_exists

        if file_exists:
            actual_size = os.path.getsize(fpath)
            total_bytes += actual_size
            b_dict["size_bytes"] = actual_size
        else:
            total_bytes += b_dict.get("size_bytes", 0)

        backups.append(b_dict)

    conn.close()

    # Format summary stats
    total_mb = round(total_bytes / (1024 * 1024), 2)
    latest_ts = backups[0]["created_at"] if backups else None

    return {
        "success": True,
        "backups": backups,
        "stats": {
            "total_count": len(backups),
            "total_bytes": total_bytes,
            "total_mb": total_mb,
            "latest_backup": latest_ts,
            "backup_dir": _get_backup_dir()
        }
    }


def create_backup_sync(
    backup_type: str = "config",
    custom_paths: Optional[List[str]] = None,
    notes: str = "",
    user_email: str = "admin"
) -> Dict[str, Any]:
    """
    Create a compressed tar.gz backup archive for the specified profile.
    Profiles:
      - 'config': /etc critical configs (nginx, ssh, systemd, hosts, etc.)
      - 'pulseops': pulseops.db and application files
      - 'web': /var/www web apps
      - 'custom': user-supplied directories/files
    """
    backup_dir = _get_backup_dir()
    ts_slug = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    safe_type = re.sub(r'[^a-zA-Z0-9_-]', '', backup_type.lower())
    filename = f"pulseops_{safe_type}_{ts_slug}.tar.gz"
    filepath = os.path.join(backup_dir, filename)

    # Determine source paths based on profile
    sources: List[str] = []
    if safe_type == "config":
        candidates = [
            "/etc/nginx", "/etc/ssh/sshd_config", "/etc/ssh/sshd_config.d",
            "/etc/systemd/system", "/etc/hosts", "/etc/resolv.conf",
            "/etc/fstab", "/etc/crontab", "/etc/cron.d"
        ]
        sources = [p for p in candidates if os.path.exists(p)]
    elif safe_type == "pulseops":
        candidates = [
            os.path.abspath(DB_PATH),
            os.path.abspath("./server.py"),
            os.path.abspath("./fastapi_app.py"),
            os.path.abspath("./.env")
        ]
        sources = [p for p in candidates if os.path.exists(p)]
    elif safe_type == "web":
        if os.path.exists("/var/www"):
            sources = ["/var/www"]
        else:
            sources = [os.path.abspath("./public")]
    elif safe_type == "custom":
        if custom_paths:
            for p in custom_paths:
                p = p.strip()
                if p and os.path.exists(p):
                    sources.append(p)

    if not sources:
        return {
            "success": False,
            "error": f"No valid files or directories found to backup for profile '{backup_type}'."
        }

    file_count = 0
    t0 = time.time()

    try:
        with tarfile.open(filepath, "w:gz") as tar:
            for src in sources:
                arcname = os.path.basename(src.rstrip("/"))
                if os.path.isfile(src):
                    tar.add(src, arcname=arcname)
                    file_count += 1
                elif os.path.isdir(src):
                    for root, dirs, files in os.walk(src):
                        for f in files:
                            full_p = os.path.join(root, f)
                            rel_p = os.path.relpath(full_p, os.path.dirname(src))
                            try:
                                tar.add(full_p, arcname=rel_p)
                                file_count += 1
                            except Exception as add_err:
                                logger.warning(f"Skipping unreadable file {full_p}: {add_err}")

        # Compute checksum and size
        size_bytes = os.path.getsize(filepath)
        checksum = _calc_sha256(filepath)
        created_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        duration_sec = round(time.time() - t0, 2)

        # Record in SQLite database
        conn = _get_db()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO backups (name, filename, filepath, backup_type, size_bytes, file_count, checksum, created_at, created_by, status, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            f"{backup_type.title()} Snapshot ({ts_slug})",
            filename,
            filepath,
            backup_type,
            size_bytes,
            file_count,
            checksum,
            created_at,
            user_email,
            "completed",
            notes or f"Archived {file_count} files across {len(sources)} source paths in {duration_sec}s"
        ))
        backup_id = cur.lastrowid
        conn.commit()
        conn.close()

        return {
            "success": True,
            "id": backup_id,
            "filename": filename,
            "filepath": filepath,
            "size_bytes": size_bytes,
            "size_mb": round(size_bytes / (1024 * 1024), 2),
            "file_count": file_count,
            "checksum": checksum,
            "created_at": created_at,
            "duration_sec": duration_sec,
            "sources": sources
        }
    except Exception as e:
        logger.error(f"Backup failed: {e}")
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception:
                pass
        return {"success": False, "error": str(e)}


def get_backup_contents_sync(backup_id: int, limit: int = 200) -> Dict[str, Any]:
    """Inspect and extract the file list from a tar.gz archive."""
    conn = _get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM backups WHERE id = ?", (backup_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        return {"success": False, "error": "Backup record not found"}

    filepath = row["filepath"]
    if not os.path.isfile(filepath):
        return {"success": False, "error": f"Backup file missing from disk: {filepath}"}

    items = []
    try:
        with tarfile.open(filepath, "r:gz") as tar:
            for member in tar.getmembers()[:limit]:
                items.append({
                    "name": member.name,
                    "size": member.size,
                    "is_dir": member.isdir(),
                    "mode": oct(member.mode),
                    "mtime": datetime.fromtimestamp(member.mtime, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                })
        return {
            "success": True,
            "backup_id": backup_id,
            "filename": row["filename"],
            "total_items": len(items),
            "items": items
        }
    except Exception as e:
        logger.error(f"Failed to read archive {filepath}: {e}")
        return {"success": False, "error": str(e)}


def verify_backup_sync(backup_id: int) -> Dict[str, Any]:
    """Verify archive integrity via tar verification and SHA256 recalculation."""
    conn = _get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM backups WHERE id = ?", (backup_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        return {"success": False, "error": "Backup not found"}

    filepath = row["filepath"]
    if not os.path.isfile(filepath):
        return {"success": False, "error": "Backup file does not exist on disk."}

    try:
        # Check archive readability
        corrupted = False
        member_count = 0
        with tarfile.open(filepath, "r:gz") as tar:
            for m in tar:
                member_count += 1

        # Check hash
        current_hash = _calc_sha256(filepath)
        recorded_hash = row["checksum"]
        hash_matched = (current_hash == recorded_hash) if recorded_hash else True

        return {
            "success": hash_matched and not corrupted,
            "verified": hash_matched and not corrupted,
            "member_count": member_count,
            "sha256_match": hash_matched,
            "current_sha256": current_hash,
            "recorded_sha256": recorded_hash,
            "message": "Archive integrity verified successfully." if hash_matched else "Checksum mismatch!"
        }
    except Exception as e:
        return {"success": False, "error": f"Archive verification failed: {e}"}


def delete_backup_sync(backup_id: int) -> Dict[str, Any]:
    """Permanently delete backup file from disk and SQLite record."""
    conn = _get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM backups WHERE id = ?", (backup_id,))
    row = cur.fetchone()

    if not row:
        conn.close()
        return {"success": False, "error": "Backup not found"}

    filepath = row["filepath"]
    if os.path.isfile(filepath):
        try:
            os.remove(filepath)
        except Exception as e:
            logger.warning(f"Could not remove physical file {filepath}: {e}")

    cur.execute("DELETE FROM backups WHERE id = ?", (backup_id,))
    conn.commit()
    conn.close()

    return {"success": True, "message": f"Backup #{backup_id} deleted."}


def get_backup_path_sync(backup_id: int) -> Optional[str]:
    """Get absolute file path for download if exists."""
    conn = _get_db()
    cur = conn.cursor()
    cur.execute("SELECT filepath FROM backups WHERE id = ?", (backup_id,))
    row = cur.fetchone()
    conn.close()
    if row and os.path.isfile(row["filepath"]):
        return row["filepath"]
    return None


# ─── Async APIs ──────────────────────────────────────────────────────────────

async def list_backups() -> Dict[str, Any]:
    return await asyncio.to_thread(list_backups_sync)

async def create_backup(backup_type: str = "config", custom_paths: Optional[List[str]] = None, notes: str = "", user_email: str = "admin") -> Dict[str, Any]:
    return await asyncio.to_thread(create_backup_sync, backup_type, custom_paths, notes, user_email)

async def get_backup_contents(backup_id: int, limit: int = 200) -> Dict[str, Any]:
    return await asyncio.to_thread(get_backup_contents_sync, backup_id, limit)

async def verify_backup(backup_id: int) -> Dict[str, Any]:
    return await asyncio.to_thread(verify_backup_sync, backup_id)

async def delete_backup(backup_id: int) -> Dict[str, Any]:
    return await asyncio.to_thread(delete_backup_sync, backup_id)

async def get_backup_path(backup_id: int) -> Optional[str]:
    return await asyncio.to_thread(get_backup_path_sync, backup_id)
