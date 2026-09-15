"""
updates_manager.py — PulseOps Enterprise OS Patch & Update Center.

Discovers upgradable system packages across Debian/Ubuntu, RHEL/CentOS/Rocky,
and Arch, flags CVE security advisories, detects pending reboot requirements,
simulates dry-run upgrades, and orchestrates live patch execution with persistent
auditing.
"""

import asyncio
import logging
import os
import re
import shutil
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("pulseops.updates")

# Cache to avoid hammering dnf/apt on rapid navigation
_cached_updates: Optional[Dict[str, Any]] = None
_last_check_time: float = 0
CACHE_TTL_SECS = 300  # 5 minutes


# ─── Package Manager & Environment Detection ──────────────────────────────────

def get_package_manager() -> Dict[str, str]:
    """Detect the host OS package manager and distribution family."""
    if shutil.which("dnf"):
        return {"manager": "dnf", "family": "rhel", "bin": shutil.which("dnf") or "dnf"}
    if shutil.which("apt-get"):
        return {"manager": "apt", "family": "debian", "bin": shutil.which("apt-get") or "apt-get"}
    if shutil.which("yum"):
        return {"manager": "yum", "family": "rhel", "bin": shutil.which("yum") or "yum"}
    if shutil.which("pacman"):
        return {"manager": "pacman", "family": "arch", "bin": shutil.which("pacman") or "pacman"}
    if shutil.which("zypper"):
        return {"manager": "zypper", "family": "suse", "bin": shutil.which("zypper") or "zypper"}
    return {"manager": "unknown", "family": "unknown", "bin": ""}


async def check_reboot_required() -> Dict[str, Any]:
    """Detect if an OS reboot is required following kernel or glibc updates."""
    # 1. Check standard Debian/Ubuntu marker
    debian_marker = "/var/run/reboot-required"
    if os.path.exists(debian_marker):
        pkgs = []
        pkgs_file = "/var/run/reboot-required.pkgs"
        if os.path.exists(pkgs_file):
            try:
                with open(pkgs_file, "r") as f:
                    pkgs = [l.strip() for l in f if l.strip()]
            except Exception:
                pass
        return {
            "reboot_required": True,
            "reason": f"System flag /var/run/reboot-required set ({len(pkgs)} packages requiring reboot)",
            "packages": pkgs,
        }

    # 2. Check running kernel vs latest installed kernel (RHEL/CentOS/Rocky/Fedora)
    running_kernel = ""
    try:
        proc = await asyncio.create_subprocess_exec(
            "uname", "-r",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        running_kernel = out.decode("utf-8").strip()
    except Exception:
        pass

    latest_installed_kernel = ""
    if shutil.which("rpm"):
        try:
            # Query the newest installed kernel package
            proc = await asyncio.create_subprocess_shell(
                "rpm -q --last kernel kernel-core 2>/dev/null | head -n 1 | awk '{print $1}'",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out, _ = await proc.communicate()
            pkg_name = out.decode("utf-8").strip()
            # Extract kernel version from package name (e.g. kernel-core-5.14.0-687.47.1.el9_8.x86_64)
            match = re.search(r"kernel(?:-core)?-(.+)", pkg_name)
            if match:
                latest_installed_kernel = match.group(1)
        except Exception:
            pass

    if running_kernel and latest_installed_kernel and running_kernel not in latest_installed_kernel and latest_installed_kernel not in running_kernel:
        return {
            "reboot_required": True,
            "reason": f"Newer kernel installed ({latest_installed_kernel}) than currently booted ({running_kernel})",
            "running_kernel": running_kernel,
            "installed_kernel": latest_installed_kernel,
            "packages": ["kernel"],
        }

    return {
        "reboot_required": False,
        "reason": "Running latest installed kernel",
        "running_kernel": running_kernel,
        "installed_kernel": latest_installed_kernel or running_kernel,
        "packages": [],
    }


# ─── Pending Updates Inspector ────────────────────────────────────────────────

async def check_updates(force_refresh: bool = False) -> Dict[str, Any]:
    """Inspect pending system updates and categorize security vs general patches."""
    global _cached_updates, _last_check_time

    now = time.time()
    if not force_refresh and _cached_updates and (now - _last_check_time < CACHE_TTL_SECS):
        return _cached_updates

    pkg_info = get_package_manager()
    manager = pkg_info["manager"]
    family = pkg_info["family"]

    reboot_info = await check_reboot_required()

    if manager == "unknown":
        return {
            "package_manager": "unknown",
            "total_updates": 0,
            "security_updates": 0,
            "packages": [],
            "reboot_info": reboot_info,
            "error": "No supported package manager found (dnf, apt, yum, pacman)",
        }

    packages: List[Dict[str, Any]] = []
    security_count = 0

    # ── DNF / YUM (RHEL, Rocky, CentOS, Fedora, Alma) ──
    if family == "rhel":
        # Check security advisories first
        security_pkg_names = set()
        try:
            sec_proc = await asyncio.create_subprocess_exec(
                manager, "check-update", "--security",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            sec_out, _ = await sec_proc.communicate()
            sec_lines = sec_out.decode("utf-8", errors="replace").splitlines()
            for l in sec_lines:
                parts = l.strip().split()
                if len(parts) >= 3 and "." in parts[0] and not parts[0].startswith("Last"):
                    pkg_name_arch = parts[0]
                    name = pkg_name_arch.rsplit(".", 1)[0]
                    security_pkg_names.add(name)
                    security_pkg_names.add(pkg_name_arch)
        except Exception as e:
            logger.debug("[Updates] dnf check-update --security error: %s", e)

        # Full check-update
        try:
            proc = await asyncio.create_subprocess_exec(
                manager, "check-update",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            # DNF returns code 100 when updates are available!
            lines = stdout.decode("utf-8", errors="replace").splitlines()
            for l in lines:
                parts = l.strip().split()
                if len(parts) >= 3 and "." in parts[0] and not parts[0].startswith("Last") and not parts[0].startswith("Obsoleting"):
                    pkg_name_arch = parts[0]
                    name_split = pkg_name_arch.rsplit(".", 1)
                    pkg_name = name_split[0]
                    pkg_arch = name_split[1] if len(name_split) > 1 else ""
                    new_version = parts[1]
                    repo = parts[2]

                    is_security = (pkg_name in security_pkg_names or pkg_name_arch in security_pkg_names)
                    if is_security:
                        security_count += 1

                    packages.append({
                        "name": pkg_name,
                        "arch": pkg_arch,
                        "version": new_version,
                        "repository": repo,
                        "type": "security" if is_security else "enhancement",
                    })
        except Exception as e:
            logger.error("[Updates] dnf check-update error: %s", e)

    # ── APT (Debian, Ubuntu) ──
    elif family == "debian":
        try:
            proc = await asyncio.create_subprocess_shell(
                "apt list --upgradable 2>/dev/null",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            lines = stdout.decode("utf-8", errors="replace").splitlines()
            for l in lines:
                # Format: package/repo version arch [upgradable from: current]
                if "/" in l and "upgradable" in l:
                    parts = l.split()
                    name_repo = parts[0].split("/")
                    name = name_repo[0]
                    repo = name_repo[1] if len(name_repo) > 1 else "apt"
                    version = parts[1] if len(parts) > 1 else ""
                    arch = parts[2] if len(parts) > 2 else ""

                    is_security = "security" in l.lower() or "esm" in l.lower()
                    if is_security:
                        security_count += 1

                    packages.append({
                        "name": name,
                        "arch": arch,
                        "version": version,
                        "repository": repo,
                        "type": "security" if is_security else "general",
                    })
        except Exception as e:
            logger.error("[Updates] apt check error: %s", e)

    result = {
        "package_manager": manager,
        "family": family,
        "total_updates": len(packages),
        "security_updates": security_count,
        "packages": packages,
        "reboot_info": reboot_info,
        "last_checked": datetime.now(timezone.utc).isoformat(),
    }

    _cached_updates = result
    _last_check_time = now
    return result


# ─── Live Upgrade Runner & Execution Auditing ─────────────────────────────────

async def run_upgrade(
    dry_run: bool = False,
    security_only: bool = False,
    user_email: str = "operator",
) -> Dict[str, Any]:
    """Execute dry-run or full system package upgrade with streaming output capture."""
    pkg_info = get_package_manager()
    manager = pkg_info["manager"]
    family = pkg_info["family"]

    if manager == "unknown":
        return {"success": False, "error": "No supported package manager detected"}

    # Construct upgrade command
    cmd: List[str] = []
    if family == "rhel":
        cmd = [manager, "upgrade"]
        if security_only:
            cmd.append("--security")
        if dry_run:
            cmd.append("--assumeno")
        else:
            cmd.append("-y")
    elif family == "debian":
        if dry_run:
            cmd = ["apt-get", "upgrade", "-s"]
        else:
            cmd = ["apt-get", "upgrade", "-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"]

    cmd_str = " ".join(cmd)
    logger.info("[Updates] Starting upgrade (dry_run=%s, security_only=%s) by %s: %s",
                dry_run, security_only, user_email, cmd_str)

    start_t = time.time()
    from database import execute

    # Create history entry
    history_id = await execute(
        "INSERT INTO update_history (initiated_by, status, started_at) VALUES (?, 'running', datetime('now'))",
        (user_email,)
    )

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        duration_secs = round(time.time() - start_t, 1)

        out_text = stdout.decode("utf-8", errors="replace")
        err_text = stderr.decode("utf-8", errors="replace")
        full_log = (out_text + "\n" + err_text).strip()[:20000]

        is_ok = proc.returncode == 0 or (dry_run and proc.returncode in (0, 1))
        status = "completed" if is_ok else "failed"

        await execute(
            "UPDATE update_history SET status = ?, finished_at = datetime('now'), log_output = ? WHERE id = ?",
            (status, full_log, history_id)
        )

        # Invalidate update cache so fresh check reflects upgraded state
        global _cached_updates
        _cached_updates = None

        return {
            "success": is_ok,
            "status": status,
            "exit_code": proc.returncode,
            "duration_secs": duration_secs,
            "log": full_log,
            "command": cmd_str,
        }
    except Exception as e:
        logger.error("[Updates] Upgrade execution failed: %s", e)
        await execute(
            "UPDATE update_history SET status = 'failed', finished_at = datetime('now'), log_output = ? WHERE id = ?",
            (str(e), history_id)
        )
        return {"success": False, "error": str(e)}


async def get_update_history(limit: int = 20) -> List[Dict[str, Any]]:
    """Return historical package upgrade records."""
    from database import fetchall
    return await fetchall(
        "SELECT * FROM update_history ORDER BY started_at DESC LIMIT ?", (limit,)
    )
