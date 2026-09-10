#!/usr/bin/env python3
"""
pulseops_agent.py — PulseOps Enterprise Lightweight Agent.

Self-contained agent that runs on managed servers. Collects telemetry using
Python stdlib and psutil, exposes a REST telemetry endpoint, and sends periodic
heartbeats to the master PulseOps server. Requires only: psutil.

Usage:
    python3 pulseops_agent.py --master-url http://master:3500 --token <agent_token>
    python3 pulseops_agent.py --config /etc/pulseops/agent.conf
"""

import argparse
import asyncio
import configparser
import json
import logging
import os
import platform
import signal
import socket
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from typing import Any, Dict, Optional
import urllib.request
import urllib.error

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("pulseops-agent")

# ─── Config ──────────────────────────────────────────────────────────────────

DEFAULT_AGENT_PORT = 3501
DEFAULT_HEARTBEAT_INTERVAL = 15  # seconds
MASTER_HEARTBEAT_PATH = "/api/fleet/heartbeat"

_config: Dict[str, Any] = {}

# ─── Telemetry Collection ─────────────────────────────────────────────────────

_prev_cpu_stat = None
_prev_net_stat = None


def get_cpu_percent() -> float:
    """Calculate CPU usage from /proc/stat or psutil fallback."""
    global _prev_cpu_stat
    try:
        if os.path.exists("/proc/stat"):
            with open("/proc/stat") as f:
                for line in f:
                    if line.startswith("cpu "):
                        parts = [float(x) for x in line.split()[1:]]
                        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
                        total = sum(parts)
                        if _prev_cpu_stat is None:
                            _prev_cpu_stat = {"idle": idle, "total": total}
                            return 5.0
                        idle_diff = idle - _prev_cpu_stat["idle"]
                        total_diff = total - _prev_cpu_stat["total"]
                        _prev_cpu_stat = {"idle": idle, "total": total}
                        if total_diff == 0:
                            return 0.0
                        return round((1.0 - idle_diff / total_diff) * 100.0, 1)
    except Exception:
        pass
    try:
        import psutil
        return round(psutil.cpu_percent(interval=None), 1)
    except Exception:
        return 0.0


def get_mem_percent() -> float:
    """Get memory usage percentage from /proc/meminfo or psutil."""
    try:
        if os.path.exists("/proc/meminfo"):
            mem = {}
            with open("/proc/meminfo") as f:
                for line in f:
                    parts = line.split(":")
                    if len(parts) == 2:
                        mem[parts[0].strip()] = int(parts[1].strip().split()[0])
            total = mem.get("MemTotal", 1)
            available = mem.get("MemAvailable", mem.get("MemFree", 0))
            used = total - available
            return round((used / total) * 100.0, 1) if total > 0 else 0.0
    except Exception:
        pass
    try:
        import psutil
        return round(psutil.virtual_memory().percent, 1)
    except Exception:
        return 0.0


def get_disk_percent(mount: str = "/") -> float:
    """Get disk usage percentage for a mount point."""
    try:
        stat = os.statvfs(mount)
        total = stat.f_blocks * stat.f_frsize
        free = stat.f_bavail * stat.f_frsize
        used = total - free
        return round((used / total) * 100.0, 1) if total > 0 else 0.0
    except Exception:
        try:
            import psutil
            return round(psutil.disk_usage(mount).percent, 1)
        except Exception:
            return 0.0


def get_net_rates() -> Dict[str, int]:
    """Get current network RX/TX rates in bytes/sec."""
    global _prev_net_stat
    try:
        if os.path.exists("/proc/net/dev"):
            rx = tx = 0
            now = time.time()
            with open("/proc/net/dev") as f:
                for line in f.readlines()[2:]:
                    if ":" in line:
                        iface, rest = line.split(":", 1)
                        if iface.strip() == "lo":
                            continue
                        parts = rest.strip().split()
                        if len(parts) >= 9:
                            rx += int(parts[0])
                            tx += int(parts[8])
            if _prev_net_stat is None:
                _prev_net_stat = {"rx": rx, "tx": tx, "time": now}
                return {"rx_sec": 0, "tx_sec": 0}
            dt = now - _prev_net_stat["time"]
            rx_sec = max(0, int((rx - _prev_net_stat["rx"]) / dt)) if dt > 0 else 0
            tx_sec = max(0, int((tx - _prev_net_stat["tx"]) / dt)) if dt > 0 else 0
            _prev_net_stat = {"rx": rx, "tx": tx, "time": now}
            return {"rx_sec": rx_sec, "tx_sec": tx_sec}
    except Exception:
        pass
    return {"rx_sec": 0, "tx_sec": 0}


def get_uptime() -> int:
    """Get system uptime in seconds."""
    try:
        if os.path.exists("/proc/uptime"):
            with open("/proc/uptime") as f:
                return int(float(f.read().split()[0]))
    except Exception:
        pass
    return 0


def get_load_avg() -> float:
    """Get 1-minute load average."""
    try:
        return round(os.getloadavg()[0], 2)
    except Exception:
        return 0.0


def get_os_info() -> str:
    """Get a human-readable OS description."""
    try:
        if os.path.exists("/etc/os-release"):
            with open("/etc/os-release") as f:
                for line in f:
                    if line.startswith("PRETTY_NAME="):
                        return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return f"{platform.system()} {platform.release()}"


def collect_snapshot() -> Dict[str, Any]:
    """Collect a full telemetry snapshot from this system."""
    net = get_net_rates()
    return {
        "cpu": get_cpu_percent(),
        "mem": get_mem_percent(),
        "disk": get_disk_percent("/"),
        "rx_sec": net["rx_sec"],
        "tx_sec": net["tx_sec"],
        "load1": get_load_avg(),
        "uptime": get_uptime(),
        "hostname": socket.gethostname(),
        "host_ip": socket.gethostbyname(socket.gethostname()),
        "os_info": get_os_info(),
        "arch": platform.machine(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ─── HTTP Server (Telemetry Endpoint) ────────────────────────────────────────

class AgentHTTPHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler exposing the agent's telemetry snapshot endpoint."""

    def log_message(self, format, *args):
        """Suppress default stdout logging."""
        pass

    def do_GET(self):
        """Handle GET requests."""
        if self.path in ("/api/telemetry/snapshot", "/health"):
            data = collect_snapshot()
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")

    def do_OPTIONS(self):
        """CORS preflight."""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()


def start_http_server(port: int) -> None:
    """Start the agent HTTP server in a background thread.

    Args:
        port: TCP port to bind to.
    """
    server = HTTPServer(("0.0.0.0", port), AgentHTTPHandler)
    logger.info("[Agent] HTTP telemetry endpoint listening on :%d", port)
    server.serve_forever()


# ─── Heartbeat Loop ───────────────────────────────────────────────────────────

def send_heartbeat(master_url: str, agent_token: str) -> bool:
    """POST a telemetry snapshot to the master server's heartbeat endpoint.

    Args:
        master_url: Base URL of the master PulseOps server.
        agent_token: Agent authentication token.

    Returns:
        True on success.
    """
    try:
        snapshot = collect_snapshot()
        payload = json.dumps(snapshot).encode()
        url = master_url.rstrip("/") + MASTER_HEARTBEAT_PATH
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Agent-Token": agent_token,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except urllib.error.URLError as e:
        logger.warning("[Agent] Heartbeat failed: %s", e.reason)
        return False
    except Exception as e:
        logger.warning("[Agent] Heartbeat error: %s", e)
        return False


def heartbeat_loop(master_url: str, agent_token: str, interval: int) -> None:
    """Run the heartbeat loop indefinitely.

    Args:
        master_url: Master server URL.
        agent_token: Agent token for authentication.
        interval: Seconds between heartbeats.
    """
    logger.info("[Agent] Heartbeat loop started → %s every %ds", master_url, interval)
    while True:
        success = send_heartbeat(master_url, agent_token)
        if success:
            logger.debug("[Agent] Heartbeat OK")
        time.sleep(interval)


# ─── Entrypoint ───────────────────────────────────────────────────────────────

def load_config(config_path: str) -> Dict[str, str]:
    """Load agent configuration from an INI-style config file.

    Args:
        config_path: Path to the config file.

    Returns:
        Dict of configuration values.
    """
    cfg = {}
    try:
        parser = configparser.ConfigParser()
        # Support key=value without sections
        with open(config_path) as f:
            content = "[default]\n" + f.read()
        parser.read_string(content)
        cfg = dict(parser["default"])
    except Exception as e:
        logger.error("Failed to load config %s: %s", config_path, e)
    return cfg


def main():
    """Parse arguments and start the agent."""
    parser = argparse.ArgumentParser(
        description="PulseOps Enterprise Agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--master-url", help="Master PulseOps server URL (e.g. http://192.168.1.100:3500)")
    parser.add_argument("--token", help="Agent authentication token")
    parser.add_argument("--config", help="Path to /etc/pulseops/agent.conf")
    parser.add_argument("--port", type=int, default=DEFAULT_AGENT_PORT, help="Local HTTP port (default: 3501)")
    parser.add_argument("--heartbeat-interval", type=int, default=DEFAULT_HEARTBEAT_INTERVAL,
                        help="Heartbeat interval in seconds (default: 15)")
    args = parser.parse_args()

    master_url = args.master_url
    agent_token = args.token
    port = args.port
    interval = args.heartbeat_interval

    # Load from config file if provided
    if args.config:
        cfg = load_config(args.config)
        master_url = master_url or cfg.get("master_url")
        agent_token = agent_token or cfg.get("agent_token")
        port = int(cfg.get("agent_port", port))

    if not master_url:
        logger.error("--master-url or MASTER_URL config required")
        sys.exit(1)
    if not agent_token:
        logger.error("--token or AGENT_TOKEN config required")
        sys.exit(1)

    logger.info("[Agent] PulseOps Agent starting — master=%s port=%d", master_url, port)

    # Graceful shutdown handler
    def handle_signal(signum, frame):
        logger.info("[Agent] Signal received — shutting down")
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Start HTTP server in background thread
    http_thread = Thread(target=start_http_server, args=(port,), daemon=True)
    http_thread.start()

    # Run heartbeat loop in main thread
    heartbeat_loop(master_url, agent_token, interval)


if __name__ == "__main__":
    main()
