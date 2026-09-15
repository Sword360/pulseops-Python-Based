"""
cron_manager.py — PulseOps Enterprise Cron & Systemd Timers Manager.

Inspects, manages, schedules, and executes system & user crontabs and systemd
timers, provides human-friendly schedule translation, on-demand task execution,
and persistent execution auditing.
"""

import asyncio
import hashlib
import logging
import os
import re
import shlex
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("pulseops.cron")

SYSTEM_CRON_DIRS = ["/etc/cron.d"]
CRON_SPECIAL = {
    "@reboot": "On system startup",
    "@yearly": "Once a year (0 0 1 1 *)",
    "@annually": "Once a year (0 0 1 1 *)",
    "@monthly": "Once a month (0 0 1 * *)",
    "@weekly": "Once a week (0 0 * * 0)",
    "@daily": "Once a day at midnight (0 0 * * *)",
    "@midnight": "Once a day at midnight (0 0 * * *)",
    "@hourly": "Once an hour at minute 0 (0 * * * *)",
}


def human_readable_schedule(expr: str) -> str:
    """Translate standard 5-part cron expression into human-readable description."""
    expr = expr.strip()
    if expr in CRON_SPECIAL:
        return CRON_SPECIAL[expr]

    parts = expr.split()
    if len(parts) != 5:
        return expr

    minute, hour, dom, month, dow = parts

    if minute == "*" and hour == "*" and dom == "*" and month == "*" and dow == "*":
        return "Every minute"
    if minute.startswith("*/") and hour == "*" and dom == "*" and month == "*" and dow == "*":
        return f"Every {minute[2:]} minutes"
    if minute == "0" and hour == "*" and dom == "*" and month == "*" and dow == "*":
        return "Every hour on the hour"
    if minute == "0" and hour.startswith("*/") and dom == "*" and month == "*" and dow == "*":
        return f"Every {hour[2:]} hours"
    if dom == "*" and month == "*" and dow == "*":
        if "," in minute or "," in hour:
            return f"At minute {minute}, hour {hour} every day"
        return f"Every day at {hour.zfill(2)}:{minute.zfill(2)}"
    if dom == "*" and month == "*":
        dow_names = {"0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat", "7": "Sun"}
        day_str = dow_names.get(dow, f"day {dow}")
        return f"Every {day_str} at {hour.zfill(2)}:{minute.zfill(2)}"
    if month == "*" and dow == "*":
        return f"On day {dom} of every month at {hour.zfill(2)}:{minute.zfill(2)}"

    return f"Schedule: {expr}"


# ─── Crontab Parser & Inspector ───────────────────────────────────────────────

def _generate_job_id(source: str, line_no: int, command: str) -> str:
    raw = f"{source}:{line_no}:{command}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:12]


async def _get_user_crontab_lines() -> List[str]:
    """Fetch raw crontab lines for the current user."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "crontab", "-l",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            return stdout.decode("utf-8", errors="replace").splitlines()
        return []
    except Exception as e:
        logger.debug("[Cron] Could not read user crontab: %s", e)
        return []


async def _save_user_crontab_lines(lines: List[str]) -> bool:
    """Save raw crontab lines via crontab command."""
    content = "\n".join(lines).strip() + "\n"
    try:
        proc = await asyncio.create_subprocess_exec(
            "crontab", "-",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate(input=content.encode("utf-8"))
        if proc.returncode == 0:
            return True
        logger.error("[Cron] crontab save failed: %s", stderr.decode("utf-8"))
        return False
    except Exception as e:
        logger.error("[Cron] crontab save error: %s", e)
        return False


async def list_cron_jobs() -> List[Dict[str, Any]]:
    """Enumerate all active and commented cron jobs across user and system crontabs."""
    jobs: List[Dict[str, Any]] = []

    # 1. User Crontab
    user_lines = await _get_user_crontab_lines()
    pending_comment = ""
    for idx, line in enumerate(user_lines):
        trimmed = line.strip()
        if not trimmed:
            continue
        if trimmed.startswith("#") and not (trimmed.startswith("# ") and any(c.isdigit() or c in ("*", "@") for c in trimmed[2:].strip())):
            # Pure commentary
            pending_comment = trimmed.lstrip("#").strip()
            continue

        is_disabled = trimmed.startswith("#")
        actual_line = trimmed.lstrip("#").strip() if is_disabled else trimmed

        # Check special alias
        if actual_line.startswith("@"):
            parts = actual_line.split(None, 1)
            if len(parts) == 2:
                schedule, command = parts
                jobs.append({
                    "id": _generate_job_id("user", idx, command),
                    "source": "user",
                    "file": "user crontab",
                    "line_number": idx,
                    "schedule": schedule,
                    "human_schedule": human_readable_schedule(schedule),
                    "user": os.environ.get("USER", "root"),
                    "command": command,
                    "comment": pending_comment,
                    "is_enabled": not is_disabled,
                })
                pending_comment = ""
                continue

        # Standard 5 fields
        parts = actual_line.split()
        if len(parts) >= 6:
            schedule = " ".join(parts[:5])
            command = " ".join(parts[5:])
            jobs.append({
                "id": _generate_job_id("user", idx, command),
                "source": "user",
                "file": "user crontab",
                "line_number": idx,
                "schedule": schedule,
                "human_schedule": human_readable_schedule(schedule),
                "user": os.environ.get("USER", "root"),
                "command": command,
                "comment": pending_comment,
                "is_enabled": not is_disabled,
            })
            pending_comment = ""

    # 2. System /etc/cron.d/* and /etc/crontab
    sys_files = ["/etc/crontab"]
    for d in SYSTEM_CRON_DIRS:
        if os.path.isdir(d):
            try:
                for fn in os.listdir(d):
                    fp = os.path.join(d, fn)
                    if os.path.isfile(fp) and not fn.startswith((".", "0", "rpm")):
                        sys_files.append(fp)
            except Exception:
                pass

    for file_path in sys_files:
        if not os.path.isfile(file_path):
            continue
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except Exception:
            continue

        p_comment = ""
        for idx, line in enumerate(lines):
            trimmed = line.strip()
            if not trimmed:
                continue
            if trimmed.startswith("#") and not (trimmed.startswith("# ") and any(c.isdigit() or c in ("*", "@") for c in trimmed[2:].strip())):
                p_comment = trimmed.lstrip("#").strip()
                continue

            is_disabled = trimmed.startswith("#")
            actual_line = trimmed.lstrip("#").strip() if is_disabled else trimmed

            parts = actual_line.split()
            # System crontabs have 6 fields: 5 schedule + user + command
            if len(parts) >= 7:
                schedule = " ".join(parts[:5])
                run_as = parts[5]
                command = " ".join(parts[6:])
                jobs.append({
                    "id": _generate_job_id(file_path, idx, command),
                    "source": "system",
                    "file": file_path,
                    "line_number": idx,
                    "schedule": schedule,
                    "human_schedule": human_readable_schedule(schedule),
                    "user": run_as,
                    "command": command,
                    "comment": p_comment,
                    "is_enabled": not is_disabled,
                })
                p_comment = ""

    return jobs


async def create_cron_job(
    schedule: str,
    command: str,
    user: str = "root",
    comment: str = "",
) -> Dict[str, Any]:
    """Add a new scheduled cron job to the user crontab."""
    schedule = schedule.strip()
    command = command.strip()

    if not command:
        return {"success": False, "error": "Command cannot be empty"}

    # Basic schedule validation
    if schedule not in CRON_SPECIAL:
        parts = schedule.split()
        if len(parts) != 5:
            return {"success": False, "error": "Cron expression must contain exactly 5 space-separated fields"}

    lines = await _get_user_crontab_lines()
    if comment:
        lines.append(f"# {comment.strip()}")
    lines.append(f"{schedule} {command}")

    success = await _save_user_crontab_lines(lines)
    if success:
        logger.info("[Cron] Created new cron job: '%s %s'", schedule, command)
        return {"success": True, "message": "Cron job created successfully"}
    return {"success": False, "error": "Failed to write crontab"}


async def toggle_cron_job(job_id: str) -> Dict[str, Any]:
    """Toggle a cron job enabled or commented out."""
    lines = await _get_user_crontab_lines()
    for idx, line in enumerate(lines):
        trimmed = line.strip()
        if not trimmed:
            continue
        actual = trimmed.lstrip("#").strip()
        parts = actual.split(None, 5)
        if len(parts) >= 6 or actual.startswith("@"):
            cmd = parts[5] if len(parts) >= 6 else parts[1]
            if _generate_job_id("user", idx, cmd) == job_id:
                if trimmed.startswith("#"):
                    lines[idx] = actual
                    new_state = True
                else:
                    lines[idx] = f"# {trimmed}"
                    new_state = False
                success = await _save_user_crontab_lines(lines)
                if success:
                    return {"success": True, "is_enabled": new_state}
                return {"success": False, "error": "Failed to update crontab"}

    return {"success": False, "error": "Cron job not found in editable user crontab"}


async def delete_cron_job(job_id: str) -> Dict[str, Any]:
    """Permanently delete a cron job from user crontab."""
    lines = await _get_user_crontab_lines()
    target_idx = -1
    for idx, line in enumerate(lines):
        trimmed = line.strip()
        actual = trimmed.lstrip("#").strip()
        parts = actual.split(None, 5)
        if len(parts) >= 6 or actual.startswith("@"):
            cmd = parts[5] if len(parts) >= 6 else parts[1]
            if _generate_job_id("user", idx, cmd) == job_id:
                target_idx = idx
                break

    if target_idx != -1:
        # Also remove preceding comment line if it belonged to this job
        del lines[target_idx]
        if target_idx > 0 and lines[target_idx - 1].strip().startswith("#"):
            del lines[target_idx - 1]

        success = await _save_user_crontab_lines(lines)
        if success:
            logger.info("[Cron] Deleted cron job id=%s", job_id)
            return {"success": True}
        return {"success": False, "error": "Failed to save updated crontab"}

    return {"success": False, "error": "Cron job not found in editable user crontab"}


# ─── Systemd Timers Inspector & Controller ────────────────────────────────────

async def list_systemd_timers() -> List[Dict[str, Any]]:
    """Enumerate systemd timers with next trigger, elapsed, unit, and target service."""
    timers: List[Dict[str, Any]] = []
    try:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "list-timers", "--all", "--no-pager", "--full",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        raw_text = stdout.decode("utf-8", errors="replace")

        lines = raw_text.splitlines()
        if not lines:
            return []

        header_idx = -1
        for i, l in enumerate(lines):
            if "NEXT" in l and "UNIT" in l and "ACTIVATES" in l:
                header_idx = i
                break

        if header_idx == -1:
            return []

        # Parse lines after header
        for l in lines[header_idx + 1:]:
            l = l.strip()
            if not l or "timers listed" in l or "Pass --all" in l:
                continue

            parts = l.split()
            # Match unit ending in .timer
            timer_unit = ""
            activates_unit = ""
            for idx, p in enumerate(parts):
                if p.endswith(".timer"):
                    timer_unit = p
                    if idx + 1 < len(parts):
                        activates_unit = parts[idx + 1]
                    break

            if not timer_unit:
                continue

            # Check unit status
            timers.append({
                "unit": timer_unit,
                "activates": activates_unit or "—",
                "raw_line": l,
                "is_active": True,
            })

    except Exception as e:
        logger.error("[Cron] Systemd timers query error: %s", e)

    return timers


async def control_systemd_timer(timer_unit: str, action: str) -> Dict[str, Any]:
    """Start, stop, restart, enable, disable, or run target service for a timer."""
    valid_actions = {"start", "stop", "restart", "enable", "disable", "run_now"}
    if action not in valid_actions:
        return {"success": False, "error": f"Invalid action. Valid: {', '.join(valid_actions)}"}

    timer_unit = timer_unit.strip()
    if not timer_unit.endswith(".timer") and not timer_unit.endswith(".service"):
        timer_unit += ".timer"

    target_unit = timer_unit
    if action == "run_now":
        # Start the activated service unit
        target_unit = timer_unit.replace(".timer", ".service")
        cmd = ["systemctl", "start", target_unit]
    else:
        cmd = ["systemctl", action, target_unit]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0:
            logger.info("[Cron] systemctl %s %s successful", action, target_unit)
            return {"success": True, "message": f"Successfully executed '{' '.join(cmd)}'"}
        return {"success": False, "error": stderr.decode("utf-8", errors="replace").strip()}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ─── On-Demand Execution & Audit History ──────────────────────────────────────

async def run_cron_now(command: str, name: str = "manual", triggered_by: str = "operator") -> Dict[str, Any]:
    """Execute a cron command immediately in the background, logging stdout/stderr and duration."""
    start_t = time.time()
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        duration_ms = int((time.time() - start_t) * 1000)
        exit_code = proc.returncode

        stdout_str = stdout.decode("utf-8", errors="replace")[:10000]
        stderr_str = stderr.decode("utf-8", errors="replace")[:10000]

        # Log into database
        from database import execute
        await execute(
            "INSERT INTO cron_executions (job_type, name, command, exit_code, stdout, stderr, duration_ms, triggered_by) "
            "VALUES ('cron', ?, ?, ?, ?, ?, ?, ?)",
            (name, command, exit_code, stdout_str, stderr_str, duration_ms, triggered_by)
        )

        return {
            "success": exit_code == 0,
            "exit_code": exit_code,
            "stdout": stdout_str,
            "stderr": stderr_str,
            "duration_ms": duration_ms,
        }
    except Exception as e:
        duration_ms = int((time.time() - start_t) * 1000)
        from database import execute
        await execute(
            "INSERT INTO cron_executions (job_type, name, command, exit_code, stdout, stderr, duration_ms, triggered_by) "
            "VALUES ('cron', ?, ?, -1, '', ?, ?, ?)",
            (name, command, str(e), duration_ms, triggered_by)
        )
        return {"success": False, "error": str(e), "duration_ms": duration_ms}


async def get_execution_history(limit: int = 50) -> List[Dict[str, Any]]:
    """Return recent cron execution history."""
    from database import fetchall
    return await fetchall(
        "SELECT * FROM cron_executions ORDER BY started_at DESC LIMIT ?", (limit,)
    )
