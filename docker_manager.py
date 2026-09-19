# -*- coding: utf-8 -*-
"""
PulseOps Enterprise — Real-Time Linux Infrastructure Management
==============================================================================
Module:       docker_manager.py
Description:  Docker & Container Management Module.
              Provides real-time container inspection, lifecycle management (start, stop,
              restart, pause, unpause, remove), live container log retrieval, and inspect
              data extraction. Supports Docker and Podman with graceful simulation fallbacks.

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
import json
import shutil
import asyncio
import subprocess
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

# Mock container dataset for demo environments or systems without Docker installed
_mock_containers_state = [
    {
        "id": "c7a8b9d0e1f2",
        "name": "pulseops-web",
        "image": "nginx:1.25-alpine",
        "status": "Up 3 hours",
        "state": "running",
        "created": "3 hours ago",
        "ports": "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp",
        "command": "nginx -g 'daemon off;'",
        "ip": "172.17.0.2",
        "mounts": [{"source": "/etc/nginx/conf.d", "destination": "/etc/nginx/conf.d", "mode": "ro", "rw": False}],
        "env": ["NGINX_PORT=80", "ENVIRONMENT=production"],
        "stats": {"cpu_percent": 0.8, "mem_usage": "24.5 MB / 512 MB", "mem_percent": 4.8, "net_io": "12.4 MB / 8.2 MB"}
    },
    {
        "id": "a1b2c3d4e5f6",
        "name": "postgres-primary",
        "image": "postgres:15-alpine",
        "status": "Up 5 days",
        "state": "running",
        "created": "5 days ago",
        "ports": "0.0.0.0:5432->5432/tcp",
        "command": "docker-entrypoint.sh postgres",
        "ip": "172.17.0.3",
        "mounts": [{"source": "/var/lib/postgresql/data", "destination": "/var/lib/postgresql/data", "mode": "rw", "rw": True}],
        "env": ["POSTGRES_DB=pulseops", "POSTGRES_USER=postgres", "PGDATA=/var/lib/postgresql/data/pgdata"],
        "stats": {"cpu_percent": 2.4, "mem_usage": "142.8 MB / 2.0 GB", "mem_percent": 6.9, "net_io": "45.1 MB / 38.6 MB"}
    },
    {
        "id": "e3f4a5b6c7d8",
        "name": "redis-cache",
        "image": "redis:7.2-alpine",
        "status": "Up 2 days",
        "state": "running",
        "created": "2 days ago",
        "ports": "0.0.0.0:6379->6379/tcp",
        "command": "docker-entrypoint.sh redis-server --save 60 1",
        "ip": "172.17.0.4",
        "mounts": [{"source": "/data", "destination": "/data", "mode": "rw", "rw": True}],
        "env": ["REDIS_VERSION=7.2.4"],
        "stats": {"cpu_percent": 0.5, "mem_usage": "38.2 MB / 1.0 GB", "mem_percent": 3.7, "net_io": "89.3 MB / 71.0 MB"}
    },
    {
        "id": "9f8e7d6c5b4a",
        "name": "node-exporter",
        "image": "prom/node-exporter:v1.7.0",
        "status": "Exited (0) 12 hours ago",
        "state": "exited",
        "created": "1 week ago",
        "ports": "0.0.0.0:9100->9100/tcp",
        "command": "/bin/node_exporter",
        "ip": "",
        "mounts": [{"source": "/proc", "destination": "/host/proc", "mode": "ro", "rw": False}],
        "env": [],
        "stats": {"cpu_percent": 0.0, "mem_usage": "0 MB / 0 MB", "mem_percent": 0.0, "net_io": "0 B / 0 B"}
    },
    {
        "id": "b5c6d7e8f9a0",
        "name": "worker-task-queue",
        "image": "python:3.11-slim",
        "status": "Paused",
        "state": "paused",
        "created": "1 day ago",
        "ports": "",
        "command": "celery -A tasks worker --loglevel=info",
        "ip": "172.17.0.5",
        "mounts": [{"source": "/app", "destination": "/app", "mode": "rw", "rw": True}],
        "env": ["PYTHONUNBUFFERED=1", "C_FORCE_ROOT=1"],
        "stats": {"cpu_percent": 0.0, "mem_usage": "56.1 MB / 1.0 GB", "mem_percent": 5.4, "net_io": "2.1 MB / 1.8 MB"}
    }
]

_MOCK_LOGS = {
    "pulseops-web": (
        "[notice] 1#1: using the \"epoll\" event method\n"
        "[notice] 1#1: nginx/1.25.3\n"
        "[notice] 1#1: built by gcc 12.2.1 20220924 (Alpine 12.2.1_git20220924)\n"
        "[notice] 1#1: OS: Linux 6.1.0-18-amd64\n"
        "192.168.1.50 - - [14/Sep/2026:10:14:22 +0000] \"GET / HTTP/1.1\" 200 615 \"-\" \"Mozilla/5.0\"\n"
        "192.168.1.50 - - [14/Sep/2026:10:14:25 +0000] \"GET /api/telemetry HTTP/1.1\" 200 482 \"-\" \"PulseOps-Agent\"\n"
        "192.168.1.52 - - [14/Sep/2026:10:15:01 +0000] \"GET /assets/app.js HTTP/1.1\" 200 50451 \"-\" \"Mozilla/5.0\""
    ),
    "postgres-primary": (
        "PostgreSQL Database directory appears to contain a database; Skipping initialization\n"
        "2026-09-14 05:00:00.123 UTC [1] LOG:  starting PostgreSQL 15.6 on x86_64-pc-linux-musl\n"
        "2026-09-14 05:00:00.125 UTC [1] LOG:  listening on IPv4 address \"0.0.0.0\", port 5432\n"
        "2026-09-14 05:00:00.130 UTC [1] LOG:  database system was shut down at 2026-09-14 04:59:58 UTC\n"
        "2026-09-14 05:00:00.145 UTC [1] LOG:  database system is ready to accept connections\n"
        "2026-09-14 05:01:10.450 UTC [28] LOG:  checkpoint starting: time\n"
        "2026-09-14 05:01:12.890 UTC [28] LOG:  checkpoint complete: wrote 42 buffers (0.3%); 0 WAL file(s) added"
    ),
    "redis-cache": (
        "1:M 14 Sep 2026 08:30:11.100 * Running mode=standalone, port=6379.\n"
        "1:M 14 Sep 2026 08:30:11.101 # Server initialized\n"
        "1:M 14 Sep 2026 08:30:11.102 * Ready to accept connections tcp\n"
        "1:M 14 Sep 2026 09:00:00.005 * DB saved on disk\n"
        "1:M 14 Sep 2026 09:30:00.012 * 100 changes in 300 seconds. Saving...\n"
        "1:M 14 Sep 2026 09:30:00.080 * Background saving started by pid 35\n"
        "35:C 14 Sep 2026 09:30:00.115 * DB saved on disk\n"
        "1:M 14 Sep 2026 09:30:00.180 * Background saving terminated with success"
    )
}


def _get_runtime_cmd() -> Optional[str]:
    """Find the container runtime CLI command (docker or podman)."""
    if shutil.which("docker"):
        return "docker"
    if shutil.which("podman"):
        return "podman"
    return None


def _socket_exists() -> bool:
    """Check if standard docker/podman unix sockets exist."""
    return os.path.exists("/var/run/docker.sock") or os.path.exists("/run/podman/podman.sock")


async def is_docker_available() -> Dict[str, Any]:
    """Inspect if Docker/Podman is installed and if the daemon is responsive."""
    runtime = _get_runtime_cmd()
    socket_found = _socket_exists()

    if not runtime and not socket_found:
        return {
            "available": False,
            "installed": False,
            "running": False,
            "engine": None,
            "version": None,
            "error": "Docker or Podman is not installed on this host."
        }

    cmd_binary = runtime or "docker"
    # Try pinging docker version / info
    try:
        cmd = f"{cmd_binary} version --format '{{{{.Server.Version}}}}'"
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0 and stdout:
            ver = stdout.decode("utf-8", errors="ignore").strip().strip("'\"")
            return {
                "available": True,
                "installed": True,
                "running": True,
                "engine": cmd_binary,
                "version": ver or "Active",
                "socket": socket_found,
                "error": None
            }

        # Try sudo fallback
        sudo_cmd = f"sudo -n {cmd_binary} version --format '{{{{.Server.Version}}}}'"
        proc_sudo = await asyncio.create_subprocess_shell(
            sudo_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        s_stdout, _ = await proc_sudo.communicate()
        if proc_sudo.returncode == 0 and s_stdout:
            ver = s_stdout.decode("utf-8", errors="ignore").strip().strip("'\"")
            return {
                "available": True,
                "installed": True,
                "running": True,
                "engine": cmd_binary,
                "version": ver or "Active",
                "socket": socket_found,
                "requires_sudo": True,
                "error": None
            }

        # If version check failed, daemon might be stopped
        err_msg = stderr.decode("utf-8", errors="ignore").strip()
        return {
            "available": False,
            "installed": True,
            "running": False,
            "engine": cmd_binary,
            "version": None,
            "error": err_msg or f"{cmd_binary} daemon is not running (systemctl start {cmd_binary})"
        }
    except Exception as e:
        return {
            "available": False,
            "installed": bool(runtime),
            "running": False,
            "engine": runtime,
            "version": None,
            "error": str(e)
        }


async def get_containers(all_containers: bool = True) -> Dict[str, Any]:
    """Retrieve all containers on the host with status, image, and network bindings.
    
    Falls back gracefully to demonstration dataset if Docker daemon is not active.
    """
    runtime = _get_runtime_cmd()
    if runtime:
        cmd_all = "-a" if all_containers else ""
        # Format string that returns JSON objects per line
        cmd = f"{runtime} ps {cmd_all} --no-trunc --format '{{{{json .}}}}'"
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()

            # If failed, try sudo -n
            if proc.returncode != 0:
                sudo_cmd = f"sudo -n {runtime} ps {cmd_all} --no-trunc --format '{{{{json .}}}}'"
                proc = await asyncio.create_subprocess_shell(
                    sudo_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
                )
                stdout, stderr = await proc.communicate()

            if proc.returncode == 0 and stdout:
                lines = stdout.decode("utf-8", errors="ignore").strip().splitlines()
                containers = []
                for line in lines:
                    if not line.strip():
                        continue
                    try:
                        raw = json.loads(line)
                        cid = raw.get("ID", "")[:12]
                        names = raw.get("Names", "")
                        clean_name = names.split(",")[0].lstrip("/") if names else cid
                        state_val = raw.get("State", "").lower() or ("running" if "up" in raw.get("Status", "").lower() else "exited")

                        containers.append({
                            "id": cid,
                            "full_id": raw.get("ID", ""),
                            "name": clean_name,
                            "image": raw.get("Image", "unknown"),
                            "status": raw.get("Status", ""),
                            "state": state_val,
                            "created": raw.get("CreatedAt", raw.get("RunningFor", "")),
                            "ports": raw.get("Ports", ""),
                            "command": raw.get("Command", ""),
                            "size": raw.get("Size", "")
                        })
                    except Exception:
                        continue

                return {
                    "success": True,
                    "fallback": False,
                    "engine": runtime,
                    "containers": containers,
                    "total": len(containers)
                }
        except Exception:
            pass

    # Fallback to simulated containers
    status_info = await is_docker_available()
    return {
        "success": True,
        "fallback": True,
        "engine": status_info.get("engine") or "docker (simulated)",
        "docker_status": status_info,
        "containers": _mock_containers_state,
        "total": len(_mock_containers_state)
    }


async def action_container(container_id: str, action: str) -> Dict[str, Any]:
    """Execute a lifecycle action on a container: start, stop, restart, pause, unpause, remove."""
    allowed_actions = {"start", "stop", "restart", "pause", "unpause", "remove"}
    if action not in allowed_actions:
        return {"success": False, "error": f"Invalid action '{action}'. Valid actions: {', '.join(allowed_actions)}"}

    if not container_id or not re.match(r"^[a-zA-Z0-9_.-]+$", container_id):
        return {"success": False, "error": "Invalid container ID or name"}

    runtime = _get_runtime_cmd()
    docker_action = "rm -f" if action == "remove" else action

    if runtime:
        cmd = f"{runtime} {docker_action} {container_id}"
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                # Try sudo -n
                sudo_cmd = f"sudo -n {runtime} {docker_action} {container_id}"
                proc = await asyncio.create_subprocess_shell(
                    sudo_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
                )
                stdout, stderr = await proc.communicate()

            if proc.returncode == 0:
                return {
                    "success": True,
                    "message": f"Container {container_id} {action}ed successfully.",
                    "fallback": False
                }
            err_msg = stderr.decode("utf-8", errors="ignore").strip()
            return {"success": False, "error": err_msg or f"Exited with code {proc.returncode}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # Fallback simulation
    global _mock_containers_state
    matched = False
    for c in _mock_containers_state:
        if c["id"] == container_id or c["name"] == container_id:
            matched = True
            if action == "start":
                c["state"] = "running"
                c["status"] = "Up just now"
            elif action == "stop":
                c["state"] = "exited"
                c["status"] = "Exited (0) just now"
            elif action == "restart":
                c["state"] = "running"
                c["status"] = "Up just now (restarted)"
            elif action == "pause":
                c["state"] = "paused"
                c["status"] = "Paused"
            elif action == "unpause":
                c["state"] = "running"
                c["status"] = "Up"
            elif action == "remove":
                _mock_containers_state = [x for x in _mock_containers_state if x["id"] != container_id and x["name"] != container_id]
            break

    if matched:
        return {
            "success": True,
            "message": f"Successfully performed '{action}' on container {container_id} (simulation mode).",
            "fallback": True
        }

    return {"success": False, "error": f"Container '{container_id}' not found."}


async def get_container_logs(container_id: str, lines: int = 100) -> Dict[str, Any]:
    """Retrieve recent stdout and stderr logs for a specified container."""
    if not container_id or not re.match(r"^[a-zA-Z0-9_.-]+$", container_id):
        return {"success": False, "error": "Invalid container ID or name"}

    safe_lines = max(10, min(int(lines), 1000))
    runtime = _get_runtime_cmd()

    if runtime:
        cmd = f"{runtime} logs --tail {safe_lines} --timestamps {container_id}"
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                sudo_cmd = f"sudo -n {runtime} logs --tail {safe_lines} --timestamps {container_id}"
                proc = await asyncio.create_subprocess_shell(
                    sudo_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
                )
                stdout, stderr = await proc.communicate()

            if proc.returncode == 0:
                out = (stdout or stderr).decode("utf-8", errors="ignore")
                return {"success": True, "logs": out or "No log output recorded yet.", "fallback": False}
            err_msg = stderr.decode("utf-8", errors="ignore").strip()
            return {"success": False, "error": err_msg or f"Exited with code {proc.returncode}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # Fallback simulation
    mock_log = _MOCK_LOGS.get(container_id)
    if not mock_log:
        for c in _mock_containers_state:
            if c["id"] == container_id and c["name"] in _MOCK_LOGS:
                mock_log = _MOCK_LOGS[c["name"]]
                break

    if not mock_log:
        mock_log = (
            f"[{datetime.now(timezone.utc).isoformat()}] Container {container_id} initialized.\n"
            f"[{datetime.now(timezone.utc).isoformat()}] Service daemon listening on standard ports.\n"
            f"[{datetime.now(timezone.utc).isoformat()}] Worker processes running healthy. Status: OK.\n"
        )

    return {"success": True, "logs": mock_log, "fallback": True}


async def inspect_container(container_id: str) -> Dict[str, Any]:
    """Inspect detailed configuration, environment variables, mounts, and network settings."""
    if not container_id or not re.match(r"^[a-zA-Z0-9_.-]+$", container_id):
        return {"success": False, "error": "Invalid container ID or name"}

    runtime = _get_runtime_cmd()
    if runtime:
        cmd = f"{runtime} inspect {container_id}"
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                sudo_cmd = f"sudo -n {runtime} inspect {container_id}"
                proc = await asyncio.create_subprocess_shell(
                    sudo_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
                )
                stdout, stderr = await proc.communicate()

            if proc.returncode == 0 and stdout:
                data = json.loads(stdout.decode("utf-8", errors="ignore"))
                if isinstance(data, list) and data:
                    raw = data[0]
                    config = raw.get("Config", {})
                    state = raw.get("State", {})
                    net = raw.get("NetworkSettings", {})
                    mounts = raw.get("Mounts", [])

                    ports_formatted = []
                    port_bindings = net.get("Ports") or {}
                    for p, bindings in port_bindings.items():
                        if bindings:
                            for b in bindings:
                                ports_formatted.append(f"{b.get('HostIp', '0.0.0.0')}:{b.get('HostPort', '')}->{p}")
                        else:
                            ports_formatted.append(p)

                    mounts_formatted = []
                    for m in mounts:
                        mounts_formatted.append({
                            "source": m.get("Source", ""),
                            "destination": m.get("Destination", ""),
                            "mode": m.get("Mode", ""),
                            "rw": m.get("RW", True)
                        })

                    ip_address = net.get("IPAddress", "")
                    if not ip_address and net.get("Networks"):
                        first_net = next(iter(net["Networks"].values()), {})
                        ip_address = first_net.get("IPAddress", "")

                    return {
                        "success": True,
                        "fallback": False,
                        "details": {
                            "id": raw.get("Id", "")[:12],
                            "full_id": raw.get("Id", ""),
                            "name": raw.get("Name", "").lstrip("/"),
                            "image": config.get("Image", ""),
                            "state": state.get("Status", ""),
                            "running": state.get("Running", False),
                            "paused": state.get("Paused", False),
                            "pid": state.get("Pid", 0),
                            "started_at": state.get("StartedAt", ""),
                            "finished_at": state.get("FinishedAt", ""),
                            "restart_policy": raw.get("HostConfig", {}).get("RestartPolicy", {}).get("Name", "no"),
                            "ip_address": ip_address,
                            "gateway": net.get("Gateway", ""),
                            "mac_address": net.get("MacAddress", ""),
                            "ports": ports_formatted,
                            "mounts": mounts_formatted,
                            "env": config.get("Env", []),
                            "command": " ".join(config.get("Cmd") or []) if isinstance(config.get("Cmd"), list) else str(config.get("Cmd") or ""),
                            "working_dir": config.get("WorkingDir", "")
                        }
                    }
        except Exception:
            pass

    # Fallback simulation
    for c in _mock_containers_state:
        if c["id"] == container_id or c["name"] == container_id:
            return {
                "success": True,
                "fallback": True,
                "details": {
                    "id": c["id"],
                    "full_id": f"{c['id']}0000000000000000000000000000000000000000000000000000",
                    "name": c["name"],
                    "image": c["image"],
                    "state": c["state"],
                    "running": c["state"] == "running",
                    "paused": c["state"] == "paused",
                    "pid": 4321 if c["state"] == "running" else 0,
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "finished_at": None,
                    "restart_policy": "unless-stopped",
                    "ip_address": c.get("ip", "172.17.0.2"),
                    "gateway": "172.17.0.1",
                    "mac_address": "02:42:ac:11:00:02",
                    "ports": c.get("ports", "").split(", ") if c.get("ports") else [],
                    "mounts": c.get("mounts", []),
                    "env": c.get("env", ["APP_ENV=production"]),
                    "command": c.get("command", ""),
                    "working_dir": "/app"
                }
            }

    return {"success": False, "error": f"Container '{container_id}' not found"}
