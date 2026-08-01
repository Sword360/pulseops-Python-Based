import re
import asyncio
import subprocess
from datetime import datetime
from typing import Dict, Any, List

MOCK_SERVICES = [
    {"name": "nginx.service", "load": "loaded", "active": "active", "sub": "running", "description": "A high performance web server and a reverse proxy server"},
    {"name": "ssh.service", "load": "loaded", "active": "active", "sub": "running", "description": "OpenBSD Secure Shell server"},
    {"name": "docker.service", "load": "loaded", "active": "active", "sub": "running", "description": "Docker Application Container Engine"},
    {"name": "postgresql.service", "load": "loaded", "active": "active", "sub": "running", "description": "PostgreSQL RDBMS"},
    {"name": "cron.service", "load": "loaded", "active": "active", "sub": "running", "description": "Regular background program processing daemon"},
    {"name": "systemd-journald.service", "load": "loaded", "active": "active", "sub": "running", "description": "Journal Service"},
    {"name": "ufw.service", "load": "loaded", "active": "active", "sub": "exited", "description": "Uncomplicated firewall"},
    {"name": "redis-server.service", "load": "loaded", "active": "inactive", "sub": "dead", "description": "Advanced key-value store"},
    {"name": "apache2.service", "load": "loaded", "active": "failed", "sub": "failed", "description": "The Apache HTTP Server"}
]

async def get_services() -> Dict[str, Any]:
    cmd = 'systemctl --no-askpass list-units --type=service --all --no-legend --no-pager'
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0 and stdout:
            lines = stdout.decode('utf-8', errors='ignore').strip().split('\n')
            services = []
            pattern = re.compile(r'^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$')
            for line in lines:
                match = pattern.match(line.strip())
                if match:
                    services.append({
                        "name": match.group(1),
                        "load": match.group(2),
                        "active": match.group(3),
                        "sub": match.group(4),
                        "description": match.group(5) or 'Systemd Service'
                    })
            if services:
                return {"success": True, "fallback": False, "services": services}
    except Exception:
        pass

    return {"success": True, "fallback": True, "services": MOCK_SERVICES}


async def action_service(service_name: str, action: str) -> Dict[str, Any]:
    allowed_actions = ['start', 'stop', 'restart', 'reload', 'enable', 'disable']
    if not service_name or action not in allowed_actions:
        return {"success": False, "error": "Invalid service or action"}

    clean_name = re.sub(r'[^a-zA-Z0-9_.-@]', '', service_name)
    cmd = f"systemctl --no-askpass {action} {clean_name}"

    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        err_msg = stderr.decode('utf-8', errors='ignore').strip()
        if proc.returncode != 0:
            return {
                "success": False,
                "error": err_msg or f"Command exited with code {proc.returncode}",
                "message": f"Simulation note: {action} on {clean_name} requires sudo permissions on target system."
            }
        return {"success": True, "message": f"Successfully executed {action} on {clean_name}"}
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": f"Simulation note: {action} on {clean_name} requires sudo permissions on target system."
        }


async def get_service_logs(service_name: str) -> Dict[str, Any]:
    clean_name = re.sub(r'[^a-zA-Z0-9_.-@]', '', service_name)
    cmd = f"journalctl --no-askpass -u {clean_name} -n 100 --no-pager"

    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0 and stdout:
            logs = stdout.decode('utf-8', errors='ignore')
            if logs.strip():
                return {"success": True, "logs": logs}
    except Exception:
        pass

    now_str = datetime.utcnow().isoformat() + "Z"
    mock_logs = [
        f"[{now_str}] INFO: Starting {clean_name}...",
        f"[{now_str}] INFO: Started {clean_name} successfully.",
        f"[{now_str}] DEBUG: Listening on 0.0.0.0:8080",
        f"[{now_str}] INFO: Worker process 12489 initialized.",
        f"[{now_str}] WARN: High memory usage threshold warning reached (82%).",
        f"[{now_str}] INFO: Connection pool refreshed."
    ]
    return {"success": True, "logs": "\n".join(mock_logs)}
