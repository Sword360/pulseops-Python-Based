"""
fleet.py — PulseOps Enterprise Fleet Management Module.

Manages the multi-server registry, agent registration/heartbeat processing,
fleet health polling loop, telemetry snapshot storage, and proxy routing for
remote server API calls.
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("pulseops.fleet")

POLL_INTERVAL = int(os.environ.get("AGENT_POLL_INTERVAL", "30"))
AGENT_TIMEOUT_SECS = 5
OFFLINE_CONSECUTIVE_THRESHOLD = 3

# In-memory state: server_id -> consecutive failure count
_failure_counts: Dict[str, int] = {}
# In-memory: latest telemetry snapshot per server
_latest_snapshots: Dict[str, Dict[str, Any]] = {}
# Fleet status broadcast callback (set by main server)
_broadcast_callback = None


def set_broadcast_callback(cb) -> None:
    """Register a WebSocket broadcast callback for fleet status updates.

    Args:
        cb: Async callable that accepts a JSON-serialisable dict payload.
    """
    global _broadcast_callback
    _broadcast_callback = cb


# ─── Server Registry CRUD ────────────────────────────────────────────────────

async def list_servers(search: Optional[str] = None, group_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return all registered servers with optional search and group filtering.

    Args:
        search: Partial match against hostname, display_name, or host_ip.
        group_id: Filter by server group UUID.

    Returns:
        List of server dicts enriched with latest snapshot data.
    """
    from database import fetchall, fetchone
    where_clauses = []
    params: list = []

    if search:
        where_clauses.append("(hostname LIKE ? OR display_name LIKE ? OR host_ip LIKE ? OR tags LIKE ?)")
        term = f"%{search}%"
        params.extend([term, term, term, term])
    if group_id:
        where_clauses.append("group_id = ?")
        params.append(group_id)

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    servers = await fetchall(
        f"SELECT id, hostname, display_name, host_ip, agent_port, os_info, arch, tags, "
        f"group_id, status, added_by, added_at, last_seen, notes, maintenance_until "
        f"FROM servers {where_sql} ORDER BY status ASC, hostname ASC",
        tuple(params)
    )

    # Enrich with latest in-memory snapshot or fallback to DB
    for srv in servers:
        snap = _latest_snapshots.get(srv["id"])
        if not snap:
            last_snap = await fetchone(
                "SELECT cpu_percent, mem_percent, disk_percent, net_rx_sec, net_tx_sec, load_avg_1, uptime "
                "FROM server_snapshots WHERE server_id = ? ORDER BY id DESC LIMIT 1",
                (srv["id"],)
            )
            if last_snap:
                snap = dict(last_snap)
                _latest_snapshots[srv["id"]] = snap
            else:
                snap = {}

        srv["latest_cpu"] = snap.get("cpu_percent")
        srv["latest_mem"] = snap.get("mem_percent")
        srv["latest_disk"] = snap.get("disk_percent")
        srv["latest_uptime"] = snap.get("uptime")
        srv["latest_load"] = snap.get("load_avg_1")
        # Parse tags JSON
        try:
            srv["tags"] = json.loads(srv["tags"] or "[]")
        except Exception:
            srv["tags"] = []

    return servers


async def get_server(server_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a single server by UUID.

    Args:
        server_id: Server UUID string.

    Returns:
        Server dict with latest snapshot, or None if not found.
    """
    from database import fetchone
    srv = await fetchone(
        "SELECT * FROM servers WHERE id = ?", (server_id,)
    )
    if not srv:
        return None
    srv["tags"] = json.loads(srv.get("tags") or "[]") if isinstance(srv.get("tags"), str) else []
    snap = _latest_snapshots.get(server_id)
    if not snap:
        last_snap = await fetchone(
            "SELECT cpu_percent, mem_percent, disk_percent, net_rx_sec, net_tx_sec, load_avg_1, uptime "
            "FROM server_snapshots WHERE server_id = ? ORDER BY id DESC LIMIT 1",
            (server_id,)
        )
        if last_snap:
            snap = dict(last_snap)
            _latest_snapshots[server_id] = snap
        else:
            snap = {}
    srv["latest_snapshot"] = snap
    return srv


async def register_server(
    hostname: str,
    host_ip: str,
    display_name: Optional[str] = None,
    agent_port: int = 3500,
    os_info: Optional[str] = None,
    arch: Optional[str] = None,
    tags: Optional[List[str]] = None,
    notes: Optional[str] = None,
    added_by: Optional[int] = None,
) -> Dict[str, Any]:
    """Register a new server in the fleet.

    Args:
        hostname: Server hostname string.
        host_ip: Server IP address.
        display_name: Human-friendly name (defaults to hostname).
        agent_port: Port where PulseOps agent listens (default 3500).
        os_info: OS description string.
        arch: CPU architecture string.
        tags: List of tag strings.
        notes: Free-text notes.
        added_by: User ID performing registration.

    Returns:
        Dict with 'success', 'server_id', and 'agent_token' on success.
    """
    from database import execute, fetchone

    if not hostname or not host_ip:
        return {"success": False, "error": "hostname and host_ip are required"}

    # Check for duplicate hostname/IP combo
    existing = await fetchone(
        "SELECT id FROM servers WHERE hostname = ? AND host_ip = ?", (hostname, host_ip)
    )
    if existing:
        return {"success": False, "error": "Server with this hostname and IP already registered"}

    server_id = str(uuid.uuid4())
    agent_token = str(uuid.uuid4())
    tags_json = json.dumps(tags or [])

    await execute(
        "INSERT INTO servers (id, hostname, display_name, host_ip, agent_port, agent_token, "
        "os_info, arch, tags, status, added_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreachable', ?, ?)",
        (server_id, hostname, display_name or hostname, host_ip, agent_port,
         agent_token, os_info, arch, tags_json, added_by, notes)
    )
    logger.info("[Fleet] Registered server %s (%s) id=%s", hostname, host_ip, server_id)
    return {"success": True, "server_id": server_id, "agent_token": agent_token}


async def update_server(server_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
    """Update server metadata fields.

    Args:
        server_id: Server UUID.
        updates: Dict of fields to update (display_name, tags, notes, agent_port, maintenance_until).

    Returns:
        Dict with 'success' bool.
    """
    from database import execute, fetchone

    srv = await fetchone("SELECT id FROM servers WHERE id = ?", (server_id,))
    if not srv:
        return {"success": False, "error": "Server not found"}

    set_clauses = []
    params = []
    allowed = {"display_name", "notes", "agent_port", "tags", "group_id", "maintenance_until"}

    for key in allowed:
        if key in updates:
            value = updates[key]
            if key == "tags":
                value = json.dumps(value) if isinstance(value, list) else value
            set_clauses.append(f"{key} = ?")
            params.append(value)

    if not set_clauses:
        return {"success": False, "error": "No valid fields to update"}

    params.append(server_id)
    await execute(f"UPDATE servers SET {', '.join(set_clauses)} WHERE id = ?", tuple(params))
    return {"success": True}


async def delete_server(server_id: str) -> Dict[str, Any]:
    """Remove a server from the fleet registry.

    Args:
        server_id: Server UUID to remove.

    Returns:
        Dict with 'success' bool.
    """
    from database import execute, fetchone
    if server_id == "local-master":
        return {"success": False, "error": "Cannot remove the local Master node from the fleet."}

    srv = await fetchone("SELECT id, hostname FROM servers WHERE id = ?", (server_id,))
    if not srv:
        return {"success": False, "error": "Server not found"}

    try:
        # Clean up referencing records that don't have CASCADE or might block FK constraint
        await execute("UPDATE invite_tokens SET used_by_server = NULL WHERE used_by_server = ?", (server_id,))
        await execute("DELETE FROM active_alerts WHERE server_id = ?", (server_id,))
        await execute("DELETE FROM server_snapshots WHERE server_id = ?", (server_id,))
        await execute("DELETE FROM maintenance_windows WHERE server_id = ?", (server_id,))
        await execute("DELETE FROM alert_rules WHERE server_id = ?", (server_id,))
        # Now delete server
        await execute("DELETE FROM servers WHERE id = ?", (server_id,))
    except Exception as e:
        logger.error("[Fleet] Failed to delete server %s: %s", server_id, e)
        return {"success": False, "error": f"Failed to delete server: {str(e)}"}

    _latest_snapshots.pop(server_id, None)
    _failure_counts.pop(server_id, None)
    logger.info("[Fleet] Deleted server %s (%s)", server_id, srv["hostname"])
    return {"success": True}


# ─── One-Time Invite Tokens ───────────────────────────────────────────────────

async def create_invite_token(created_by: int, expires_hours: int = 24) -> Dict[str, Any]:
    """Generate a single-use invite token for agent auto-registration.

    Args:
        created_by: User ID generating the token.
        expires_hours: Token validity in hours (default 24).

    Returns:
        Dict with 'token' and 'expires_at'.
    """
    from database import execute
    token = str(uuid.uuid4())
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=expires_hours)).isoformat()
    await execute(
        "INSERT INTO invite_tokens (token, created_by, expires_at) VALUES (?, ?, ?)",
        (token, created_by, expires_at)
    )
    return {"token": token, "expires_at": expires_at}


async def list_invite_tokens(created_by: Optional[int] = None) -> List[Dict[str, Any]]:
    """List active (unused, unexpired) invite tokens.

    Args:
        created_by: Optional filter by creator user ID.

    Returns:
        List of invite token dicts.
    """
    from database import fetchall
    if created_by:
        return await fetchall(
            "SELECT token, created_at, expires_at, used, used_by_server FROM invite_tokens "
            "WHERE created_by = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC",
            (created_by,)
        )
    return await fetchall(
        "SELECT token, created_by, created_at, expires_at, used, used_by_server FROM invite_tokens "
        "WHERE used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC"
    )


async def revoke_invite_token(token: str) -> Dict[str, Any]:
    """Revoke an unused invite token.

    Args:
        token: Token UUID string to revoke.

    Returns:
        Dict with 'success' bool.
    """
    from database import execute
    await execute("DELETE FROM invite_tokens WHERE token = ?", (token,))
    return {"success": True}


async def consume_invite_token(token: str) -> Optional[Dict[str, Any]]:
    """Validate and consume a one-time invite token during agent registration.

    Args:
        token: Token UUID string from the agent.

    Returns:
        Token dict on success, None if invalid/expired/used.
    """
    from database import fetchone, execute
    row = await fetchone(
        "SELECT token, created_by FROM invite_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')",
        (token,)
    )
    if not row:
        return None
    # Mark as used (will be linked after server creation)
    await execute("UPDATE invite_tokens SET used = 1 WHERE token = ?", (token,))
    return dict(row)


# ─── Agent Heartbeat & Status Updates ────────────────────────────────────────

async def process_heartbeat(agent_token: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Process an incoming heartbeat from a PulseOps agent.

    Updates last_seen, status, and stores telemetry snapshot.

    Args:
        agent_token: Agent authentication token from X-Agent-Token header.
        payload: Heartbeat data dict with cpu, mem, disk, uptime fields.

    Returns:
        Dict with 'success' bool and 'server_id' on success.
    """
    from database import fetchone, execute

    server = await fetchone(
        "SELECT id, hostname, status FROM servers WHERE agent_token = ?", (agent_token,)
    )
    if not server:
        return {"success": False, "error": "Unknown agent token"}

    server_id = server["id"]
    was_offline = server["status"] in ("offline", "unreachable")

    # Compute new status
    cpu = float(payload.get("cpu", 0))
    mem = float(payload.get("mem", 0))
    new_status = "degraded" if (cpu > 85 or mem > 90) else "online"

    # Update server record
    await execute(
        "UPDATE servers SET status = ?, last_seen = datetime('now'), "
        "os_info = COALESCE(?, os_info), arch = COALESCE(?, arch) WHERE id = ?",
        (new_status, payload.get("os_info"), payload.get("arch"), server_id)
    )

    # Store snapshot
    snapshot = {
        "cpu_percent": cpu,
        "mem_percent": mem,
        "disk_percent": float(payload.get("disk", 0)),
        "net_rx_sec": int(payload.get("rx_sec", 0)),
        "net_tx_sec": int(payload.get("tx_sec", 0)),
        "load_avg_1": float(payload.get("load1", 0)),
        "uptime": int(payload.get("uptime", 0)),
        "os_info": payload.get("os_info") or server.get("os_info"),
        "arch": payload.get("arch") or server.get("arch"),
    }
    _latest_snapshots[server_id] = snapshot
    await execute(
        "INSERT INTO server_snapshots (server_id, timestamp, cpu_percent, mem_percent, disk_percent, "
        "net_rx_sec, net_tx_sec, load_avg_1, uptime) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)",
        (server_id, snapshot["cpu_percent"], snapshot["mem_percent"], snapshot["disk_percent"],
         snapshot["net_rx_sec"], snapshot["net_tx_sec"], snapshot["load_avg_1"], snapshot["uptime"])
    )

    # Reset failure count
    _failure_counts[server_id] = 0

    # Resolve offline alerts if server came back
    if was_offline:
        try:
            from alerts import resolve_agent_offline
            await resolve_agent_offline(server_id)
        except Exception:
            pass

    # Evaluate alert rules
    try:
        from alerts import evaluate_alerts_for_server
        await evaluate_alerts_for_server(server_id, snapshot)
    except Exception as e:
        logger.debug("[Fleet] Alert evaluation error: %s", e)

    # Broadcast update to connected WebSocket clients
    if _broadcast_callback:
        try:
            await _broadcast_callback({
                "type": "fleetUpdate",
                "server_id": server_id,
                "hostname": server.get("hostname"),
                "display_name": server.get("display_name"),
                "host_ip": server.get("host_ip"),
                "agent_port": server.get("agent_port", 3501),
                "os_info": snapshot.get("os_info") or server.get("os_info"),
                "status": new_status,
                "snapshot": snapshot,
            })
        except Exception:
            pass

    return {"success": True, "server_id": server_id, "status": new_status}


async def get_server_metrics_history(
    server_id: str,
    metric: str = "cpu_percent",
    range_hours: int = 24,
) -> List[Dict[str, Any]]:
    """Retrieve time-bucketed historical metrics for a server.

    Args:
        server_id: Server UUID.
        metric: Column name to aggregate (cpu_percent, mem_percent, etc.).
        range_hours: How many hours of history to return.

    Returns:
        List of dicts with 'time_bucket' and 'avg_value'.
    """
    from database import fetchall
    safe_metrics = {"cpu_percent", "mem_percent", "disk_percent", "net_rx_sec", "net_tx_sec", "load_avg_1"}
    if metric not in safe_metrics:
        metric = "cpu_percent"

    # Bucket by 5-minute intervals
    return await fetchall(
        f"SELECT strftime('%Y-%m-%dT%H:%M:00', timestamp) as time_bucket, "
        f"AVG({metric}) as avg_value, MAX({metric}) as max_value "
        f"FROM server_snapshots "
        f"WHERE server_id = ? AND timestamp > datetime('now', '-{range_hours} hours') "
        f"GROUP BY strftime('%Y-%m-%dT%H:%M', timestamp, 'start of minute', '-' || (strftime('%M', timestamp) % 5) || ' minutes') "
        f"ORDER BY time_bucket ASC",
        (server_id,)
    )


# ─── Fleet Health Polling Loop ────────────────────────────────────────────────

async def fleet_health_poll_loop() -> None:
    """Background task: periodically poll all servers and update fleet status.

    Runs indefinitely, polling each registered server every POLL_INTERVAL seconds.
    Servers that fail OFFLINE_CONSECUTIVE_THRESHOLD consecutive polls are marked offline.
    """
    logger.info("[Fleet] Health polling loop started (interval=%ds)", POLL_INTERVAL)
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        try:
            await _poll_all_servers()
            from database import cleanup_old_snapshots, cleanup_expired_tokens
            await cleanup_old_snapshots()
            await cleanup_expired_tokens()
        except Exception as e:
            logger.error("[Fleet] Polling loop error: %s", e)


async def _poll_all_servers() -> None:
    """Poll each registered server for its current telemetry snapshot."""
    from database import fetchall, execute
    servers = await fetchall(
        "SELECT id, hostname, host_ip, agent_port, agent_token, status FROM servers"
    )
    if not servers:
        return

    tasks = [_poll_server(srv) for srv in servers]
    await asyncio.gather(*tasks, return_exceptions=True)


async def _poll_server(server: Dict[str, Any]) -> None:
    """Poll a single server for its telemetry snapshot via HTTP.

    Args:
        server: Server dict from the database.
    """
    server_id = server["id"]
    hostname = server["hostname"]
    host_ip = server["host_ip"]
    port = server.get("agent_port", 3500)
    url = f"http://{host_ip}:{port}/api/telemetry/snapshot"

    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            headers = {"X-Agent-Token": server.get("agent_token", "")}
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=AGENT_TIMEOUT_SECS),
                                   headers=headers) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    await process_heartbeat(server["agent_token"], data)
                    _failure_counts[server_id] = 0
                else:
                    await _handle_poll_failure(server_id, hostname)
    except ImportError:
        # aiohttp not available — mark as unreachable
        pass
    except asyncio.TimeoutError:
        await _handle_poll_failure(server_id, hostname)
    except Exception as e:
        logger.debug("[Fleet] Poll failed for %s (%s): %s", hostname, host_ip, e)
        await _handle_poll_failure(server_id, hostname)


async def _handle_poll_failure(server_id: str, hostname: str) -> None:
    """Increment failure counter and mark server offline if threshold reached.

    Args:
        server_id: Server UUID.
        hostname: Hostname for logging.
    """
    from database import execute
    count = _failure_counts.get(server_id, 0) + 1
    _failure_counts[server_id] = count

    if count >= OFFLINE_CONSECUTIVE_THRESHOLD:
        await execute("UPDATE servers SET status = 'offline' WHERE id = ?", (server_id,))
        logger.warning("[Fleet] Server %s (%s) marked OFFLINE after %d failures", hostname, server_id, count)
        try:
            from alerts import evaluate_agent_offline
            await evaluate_agent_offline(server_id, hostname)
        except Exception:
            pass
        if _broadcast_callback:
            try:
                await _broadcast_callback({
                    "type": "fleetUpdate",
                    "server_id": server_id,
                    "hostname": hostname,
                    "status": "offline",
                    "snapshot": {},
                })
            except Exception:
                pass


# ─── Agent Installation Script ────────────────────────────────────────────────

def get_agent_install_script(master_url: str, invite_token: str) -> str:
    """Generate the agent installation shell script dynamically.

    Args:
        master_url: Public URL of the PulseOps master server.
        invite_token: One-time registration invite token UUID.

    Returns:
        Shell script string for piping through bash.
    """
    return f"""#!/usr/bin/env bash
# PulseOps Enterprise — Agent Auto-Install Script
# Generated at: $(date -u)
# Master URL: {master_url}
# Token expires: 24 hours from generation

set -e

MASTER_URL="{master_url}"
INVITE_TOKEN="{invite_token}"
AGENT_PORT=3501
INSTALL_DIR="/opt/pulseops-agent"
SERVICE_NAME="pulseops-agent"

echo "⚡ PulseOps Enterprise Agent Installer"
echo "======================================="
echo "Master: $MASTER_URL"
echo ""

# Detect root / sudo
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo &>/dev/null; then
        SUDO="sudo"
    else
        echo "❌ This installer requires root privileges. Please run as root or install sudo."
        exit 1
    fi
fi

# Detect OS & package manager
if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt-get"
    INSTALL_CMD="apt-get install -y"
elif command -v yum &>/dev/null; then
    PKG_MANAGER="yum"
    INSTALL_CMD="yum install -y"
elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
    INSTALL_CMD="dnf install -y"
elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
    INSTALL_CMD="pacman -S --noconfirm"
else
    PKG_MANAGER="unknown"
    echo "⚠️ Unknown package manager. Checking for python3..."
fi

echo "📦 Detected package manager: $PKG_MANAGER"

# Install dependencies via system package manager (avoids PEP 668 externally-managed-environment)
echo "📦 Installing system dependencies..."
if [ "$PKG_MANAGER" = "apt-get" ]; then
    $SUDO apt-get update -qq || true
    $SUDO $INSTALL_CMD python3 python3-psutil python3-pip curl || true
elif [ "$PKG_MANAGER" = "yum" ] || [ "$PKG_MANAGER" = "dnf" ]; then
    $SUDO $INSTALL_CMD python3 python3-psutil python3-pip curl || true
elif [ "$PKG_MANAGER" = "pacman" ]; then
    $SUDO $INSTALL_CMD python python-psutil python-pip curl || true
fi

# Verify Python 3 is installed
if ! command -v python3 &>/dev/null; then
    echo "❌ Python 3 could not be found or installed. Please install Python 3.10+ manually."
    exit 1
fi

PYTHON_BIN=$(command -v python3 || echo "/usr/bin/python3")
PYTHON_VER=$($PYTHON_BIN -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo "0")
echo "✅ Python 3.$PYTHON_VER found ($PYTHON_BIN)"

# Ensure psutil is available (support modern Python PEP 668 --break-system-packages)
if ! $PYTHON_BIN -c "import psutil" &>/dev/null; then
    echo "📦 Setting up psutil..."
    if command -v pip3 &>/dev/null; then
        $SUDO pip3 install psutil --break-system-packages --quiet 2>/dev/null || \
        pip3 install psutil --break-system-packages --quiet 2>/dev/null || \
        $SUDO pip3 install psutil --quiet 2>/dev/null || \
        pip3 install psutil --quiet 2>/dev/null || true
    fi
fi

if $PYTHON_BIN -c "import psutil" &>/dev/null; then
    echo "✅ psutil loaded successfully"
else
    echo "ℹ️  psutil not installed; agent will use native /proc kernel telemetry."
fi

# Create installation directory
$SUDO mkdir -p "$INSTALL_DIR"

echo "⬇️  Downloading PulseOps agent..."
$SUDO curl -sSL "$MASTER_URL/api/fleet/agent-download" -o "$INSTALL_DIR/pulseops_agent.py"
$SUDO chmod +x "$INSTALL_DIR/pulseops_agent.py"

# Create config directory
$SUDO mkdir -p /etc/pulseops

# Get hostname and IP with safe fallbacks
HOSTNAME=$(hostname -f 2>/dev/null || hostname 2>/dev/null || uname -n)
HOST_IP=$(hostname -I 2>/dev/null | awk '{{print $1}}')
if [ -z "$HOST_IP" ]; then
    HOST_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{{print $7}}' || echo "127.0.0.1")
fi

OS_NAME=""
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_NAME="$PRETTY_NAME"
fi
[ -z "$OS_NAME" ] && OS_NAME="$(uname -s) $(uname -r)"

echo "📡 Registering with master server ($HOSTNAME @ $HOST_IP)..."
RESPONSE=$(curl -sSL -X POST "$MASTER_URL/api/fleet/register" \\
    -H "Content-Type: application/json" \\
    -d "{{
        \\"invite_token\\": \\"$INVITE_TOKEN\\",
        \\"hostname\\": \\"$HOSTNAME\\",
        \\"host_ip\\": \\"$HOST_IP\\",
        \\"agent_port\\": $AGENT_PORT,
        \\"os_info\\": \\"$OS_NAME\\",
        \\"arch\\": \\"$(uname -m)\\"
    }}")

AGENT_TOKEN=$(echo "$RESPONSE" | $PYTHON_BIN -c "import sys, json; d=json.load(sys.stdin); print(d.get('agent_token',''))" 2>/dev/null)

if [ -z "$AGENT_TOKEN" ]; then
    echo "❌ Registration failed. Server response: $RESPONSE"
    exit 1
fi

echo "✅ Registered! Agent token received."

# Write config
$SUDO tee /etc/pulseops/agent.conf > /dev/null <<EOF
MASTER_URL=$MASTER_URL
AGENT_TOKEN=$AGENT_TOKEN
AGENT_PORT=$AGENT_PORT
EOF

$SUDO chmod 600 /etc/pulseops/agent.conf

# Create systemd service
$SUDO tee /etc/systemd/system/$SERVICE_NAME.service > /dev/null <<EOF
[Unit]
Description=PulseOps Enterprise Agent
After=network.target

[Service]
Type=simple
User=root
ExecStart=$PYTHON_BIN $INSTALL_DIR/pulseops_agent.py --config /etc/pulseops/agent.conf
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now $SERVICE_NAME

echo ""
echo "✅ PulseOps Agent installed and running!"
echo "   Service: systemctl status $SERVICE_NAME"
echo "   Logs:    journalctl -u $SERVICE_NAME -f"
echo ""
echo "🔗 The server should appear in your fleet dashboard within 30 seconds."
"""


def get_agent_update_script(master_url: str) -> str:
    """Generate bash script to update the agent in-place."""
    return f"""#!/bin/bash
set -e
echo "⚡ Updating PulseOps Enterprise Agent..."
MASTER_URL="{master_url.rstrip('/')}"
SERVICE_NAME="pulseops-agent"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Download the latest agent into a temporary file first
TMP_FILE=$(mktemp /tmp/pulseops_agent_XXXXXX.py)
echo "📦 Downloading latest agent from $MASTER_URL..."
curl -sSL -k "$MASTER_URL/api/fleet/agent-download" -o "$TMP_FILE"

# Verify downloaded file is valid Python
if ! python3 -m py_compile "$TMP_FILE" 2>/dev/null; then
    echo "❌ Downloaded file failed syntax verification."
    rm -f "$TMP_FILE"
    exit 1
fi

# Detect all possible install locations and update them
UPDATED=0
for DIR in "/opt/pulseops-agent" "/usr/local/bin" "/usr/bin"; do
    if [ -f "$DIR/pulseops_agent.py" ] || [ -d "$DIR" ]; then
        $SUDO mkdir -p "$DIR"
        $SUDO cp -f "$TMP_FILE" "$DIR/pulseops_agent.py"
        $SUDO chmod 755 "$DIR/pulseops_agent.py"
        echo "   Updated $DIR/pulseops_agent.py"
        UPDATED=1
    fi
done

if [ "$UPDATED" -eq 0 ]; then
    $SUDO mkdir -p /opt/pulseops-agent
    $SUDO cp -f "$TMP_FILE" /opt/pulseops-agent/pulseops_agent.py
    $SUDO chmod 755 /opt/pulseops-agent/pulseops_agent.py
fi

rm -f "$TMP_FILE"

echo "🔄 Restarting $SERVICE_NAME..."
$SUDO systemctl daemon-reload 2>/dev/null || true
$SUDO systemctl restart $SERVICE_NAME
sleep 1

if systemctl is-active --quiet $SERVICE_NAME 2>/dev/null; then
    echo "✅ PulseOps Enterprise Agent updated and running successfully!"
else
    echo "⚠️ Agent restarted, check status: sudo systemctl status $SERVICE_NAME"
fi
"""


async def get_recent_snapshots(server_id: str, limit: int = 30) -> List[Dict[str, Any]]:
    """Retrieve the most recent telemetry snapshots for a server in chronological order."""
    from database import fetchall
    rows = await fetchall(
        "SELECT timestamp, cpu_percent, mem_percent, disk_percent, net_rx_sec, net_tx_sec, load_avg_1, uptime "
        "FROM server_snapshots WHERE server_id = ? ORDER BY id DESC LIMIT ?",
        (server_id, limit)
    )
    return [dict(r) for r in reversed(rows)]


async def ensure_local_server(port: int = 3500) -> str:
    """Ensure the local host is registered in the servers table as master."""
    from database import fetchone, execute
    local = await fetchone("SELECT id FROM servers WHERE host_ip = '127.0.0.1' OR tags LIKE '%master%' LIMIT 1")
    if local:
        return local["id"]

    import socket
    import uuid
    import platform

    server_id = "local-master"
    token = str(uuid.uuid4())
    hostname = socket.gethostname() or "localhost"
    os_info = platform.platform()
    arch = platform.machine()

    await execute(
        "INSERT OR IGNORE INTO servers (id, hostname, display_name, host_ip, agent_port, agent_token, os_info, arch, tags, status, last_seen) "
        "VALUES (?, ?, ?, '127.0.0.1', ?, ?, ?, ?, '[\"master\", \"local\"]', 'online', datetime('now'))",
        (server_id, hostname, f"{hostname} (Master)", port, token, os_info, arch)
    )
    return server_id


def update_local_snapshot(server_id: str, telemetry_data: Dict[str, Any]) -> None:
    """Update in-memory latest snapshot for the local server from telemetry loop."""
    mem = telemetry_data.get("memory", {})
    disks = telemetry_data.get("disks", [])
    net = telemetry_data.get("network", {})
    sys_info = telemetry_data.get("sysInfo", {})

    snapshot = {
        "cpu_percent": float(telemetry_data.get("cpu", 0)),
        "mem_percent": float(mem.get("usagePercent", 0)),
        "disk_percent": float(disks[0]["usagePercent"]) if disks else 0.0,
        "net_rx_sec": int(net.get("rxSec", 0)),
        "net_tx_sec": int(net.get("txSec", 0)),
        "load_avg_1": float((sys_info.get("loadAvg") or [0])[0]),
        "uptime": int(sys_info.get("uptime", 0)),
    }
    _latest_snapshots[server_id] = snapshot

