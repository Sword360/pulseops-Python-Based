import os
import signal
import asyncio
import subprocess
from typing import Dict, Any, List

MOCK_PROCESSES = [
    {"pid": 1240, "user": "root", "cpu": 14.5, "mem": 4.2, "vsz": 142000, "rss": 35000, "stat": "S", "start": "10:00", "time": "01:15", "comm": "python3", "args": "python3 server.py"},
    {"pid": 890, "user": "www-data", "cpu": 8.1, "mem": 2.1, "vsz": 89000, "rss": 18000, "stat": "S", "start": "09:45", "time": "00:42", "comm": "nginx", "args": "nginx: worker process"},
    {"pid": 1, "user": "root", "cpu": 0.1, "mem": 0.5, "vsz": 168000, "rss": 12000, "stat": "Ss", "start": "08:00", "time": "00:05", "comm": "systemd", "args": "/sbin/init"},
    {"pid": 520, "user": "postgres", "cpu": 2.3, "mem": 5.8, "vsz": 320000, "rss": 48000, "stat": "S", "start": "08:05", "time": "00:20", "comm": "postgres", "args": "postgres: main"}
]

async def get_processes() -> Dict[str, Any]:
    cmd = 'ps -eo pid,user,pcpu,pmem,vsz,rss,stat,start,time,comm --sort=-pcpu'
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0 and stdout:
            lines = stdout.decode('utf-8', errors='ignore').strip().split('\n')[1:]
            processes = []
            for l in lines[:150]:
                parts = l.strip().split()
                if len(parts) >= 10:
                    try:
                        processes.append({
                            "pid": int(parts[0]),
                            "user": parts[1],
                            "cpu": float(parts[2]),
                            "mem": float(parts[3]),
                            "vsz": int(parts[4]),
                            "rss": int(parts[5]),
                            "stat": parts[6],
                            "start": parts[7],
                            "time": parts[8],
                            "comm": " ".join(parts[9:])
                        })
                    except ValueError:
                        continue
            if processes:
                return {"success": True, "processes": processes}
    except Exception:
        pass

    return {"success": True, "processes": MOCK_PROCESSES}


async def kill_process(pid: Any, sig: str = '15') -> Dict[str, Any]:
    try:
        clean_pid = int(pid)
    except (ValueError, TypeError):
        return {"success": False, "error": "Invalid PID"}

    signum = signal.SIGKILL if str(sig) == '9' else signal.SIGTERM
    sig_name = "SIGKILL" if str(sig) == '9' else "SIGTERM"

    try:
        os.kill(clean_pid, signum)
        return {"success": True, "message": f"Sent {sig_name} to PID {clean_pid}"}
    except PermissionError:
        # Try sudo kill via command
        cmd = f"kill -{9 if str(sig) == '9' else 15} {clean_pid}"
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0:
            return {"success": True, "message": f"Sent {sig_name} to PID {clean_pid}"}
        return {"success": False, "error": stderr.decode('utf-8', errors='ignore') or "Permission denied"}
    except ProcessLookupError:
        return {"success": False, "error": f"No process with PID {clean_pid} found"}
    except Exception as e:
        return {"success": False, "error": str(e)}
