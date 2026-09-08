"""
fastapi_app.py — PulseOps Enterprise FastAPI/ASGI Application.

Extends the original single-server dashboard with:
- JWT authentication and role-based access control
- Multi-server fleet management and agent proxy
- User management CRUD APIs
- Alert rule management and notification history
- Audit log access
- System settings management
- Agent registration and heartbeat endpoints
- One-time invite token system
"""

import os
import json
import random
import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import (
    FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body,
    Depends, Header, Query, Request, Response
)
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

import telemetry
import services
import processes
import terminal
import vnc

# Enterprise modules (gracefully degrade if DB not initialized)
try:
    import database
    import auth
    import users as users_module
    import fleet as fleet_module
    import alerts as alerts_module
    import audit
    ENTERPRISE_AVAILABLE = True
except ImportError as e:
    ENTERPRISE_AVAILABLE = False
    print(f"[Warning] Enterprise modules not fully available: {e}")

# ─── App Setup ────────────────────────────────────────────────────────────────

app = FastAPI(
    title="PulseOps Enterprise API",
    description="Real-time Linux server management dashboard and multi-server fleet operations platform",
    version="2.0.0",
)

CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), 'public')
if os.path.exists(PUBLIC_DIR):
    app.mount("/css", StaticFiles(directory=os.path.join(PUBLIC_DIR, "css")), name="css")
    app.mount("/js", StaticFiles(directory=os.path.join(PUBLIC_DIR, "js")), name="js")

connected_clients: set = set()
MASTER_URL = os.environ.get("MASTER_URL", "")


# ─── Auth Helpers ─────────────────────────────────────────────────────────────

async def get_auth_user(authorization: str = Header(default="")) -> Dict[str, Any]:
    """FastAPI dependency: extract and validate authenticated user from JWT.

    Args:
        authorization: Bearer token header value.

    Returns:
        Authenticated user dict.

    Raises:
        HTTPException: 401 if token missing/invalid.
    """
    if not ENTERPRISE_AVAILABLE:
        return {"id": 1, "email": "admin@pulseops.local", "role": "admin", "display_name": "Admin"}
    user = await auth.get_current_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


async def require_admin(authorization: str = Header(default="")) -> Dict[str, Any]:
    """FastAPI dependency: require admin role."""
    user = await get_auth_user(authorization)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def require_operator(authorization: str = Header(default="")) -> Dict[str, Any]:
    """FastAPI dependency: require admin or operator role."""
    user = await get_auth_user(authorization)
    if user["role"] not in ("admin", "operator"):
        raise HTTPException(status_code=403, detail="Operator or admin access required")
    return user


def get_client_ip(request: Request) -> str:
    """Extract the real client IP from request headers.

    Args:
        request: FastAPI Request object.

    Returns:
        IP address string.
    """
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


# ─── Static Routes ────────────────────────────────────────────────────────────

@app.get("/")
async def get_index():
    """Serve the main dashboard (requires auth — JS will redirect to /login)."""
    index_path = os.path.join(PUBLIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return HTMLResponse("<h1>PulseOps Enterprise Dashboard</h1>")


@app.get("/login")
async def get_login():
    """Serve the login page."""
    login_path = os.path.join(PUBLIC_DIR, "login.html")
    if os.path.exists(login_path):
        return FileResponse(login_path)
    return HTMLResponse("<h1>Login</h1>")


# ─── Auth Endpoints ───────────────────────────────────────────────────────────

@app.post("/api/auth/login")
async def api_login(request: Request, payload: Dict[str, Any] = Body(...)):
    """Authenticate user and return JWT tokens.

    Args:
        payload: {email, password, totp_code (optional)}

    Returns:
        {access_token, refresh_token, user: {id, email, display_name, role}}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")

    email = payload.get("email", "").strip().lower()
    password = payload.get("password", "")
    totp_code = payload.get("totp_code")
    ip = get_client_ip(request)

    # Rate limit check
    if not await auth.check_rate_limit(ip):
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again in 1 minute.")

    user = await users_module.authenticate_user(email, password)
    if not user:
        await audit.log_action("auth.login", user_email=email, ip_address=ip, result="failure",
                               details={"reason": "invalid_credentials"})
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if user.get("locked"):
        await audit.log_action("auth.login", user_email=email, ip_address=ip, result="failure",
                               details={"reason": "account_locked", "locked_until": user.get("locked_until")})
        raise HTTPException(status_code=423, detail=f"Account locked until {user.get('locked_until')}")

    # TOTP check if enabled
    if user.get("totp_enabled"):
        if not totp_code:
            return JSONResponse({"totp_required": True}, status_code=200)
        if not auth.verify_totp(user["totp_secret"], totp_code):
            await audit.log_action("auth.login", user_id=user["id"], user_email=email, ip_address=ip,
                                   result="failure", details={"reason": "invalid_totp"})
            raise HTTPException(status_code=401, detail="Invalid 2FA code")

    # Success
    await auth.reset_failed_login(user["id"])
    access_token = auth.create_access_token(user["id"], user["email"], user["role"])
    refresh_token = auth.create_refresh_token(user["id"])
    await audit.log_action("auth.login", user_id=user["id"], user_email=email, ip_address=ip)

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "email": user["email"],
            "display_name": user["display_name"],
            "role": user["role"],
        }
    }


@app.post("/api/auth/logout")
async def api_logout(current_user: Dict = Depends(get_auth_user)):
    """Invalidate the current JWT token (blacklist it).

    Returns:
        {"success": true}
    """
    if not ENTERPRISE_AVAILABLE:
        return {"success": True}
    jti = current_user.get("jti")
    exp = current_user.get("exp")
    if jti and exp:
        from datetime import datetime
        expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
        await auth.blacklist_token(jti, expires_at)
    await audit.log_action("auth.logout", user_id=current_user["id"], user_email=current_user["email"])
    return {"success": True}


@app.post("/api/auth/refresh")
async def api_refresh(payload: Dict[str, Any] = Body(...)):
    """Exchange a refresh token for a new access token.

    Args:
        payload: {refresh_token}

    Returns:
        {access_token}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")
    refresh_token = payload.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status_code=400, detail="refresh_token required")
    decoded = auth.decode_token(refresh_token, "refresh")
    if not decoded:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    user = await users_module.get_user_by_id(int(decoded["sub"]))
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    new_token = auth.create_access_token(user["id"], user["email"], user["role"])
    return {"access_token": new_token, "token_type": "bearer"}


@app.get("/api/auth/me")
async def api_me(current_user: Dict = Depends(get_auth_user)):
    """Return the current authenticated user's profile.

    Returns:
        {id, email, display_name, role, totp_enabled}
    """
    if not ENTERPRISE_AVAILABLE:
        return current_user
    user = await users_module.get_user_by_id(current_user["id"])
    return user


# ─── User Management ──────────────────────────────────────────────────────────

@app.get("/api/admin/users")
async def api_list_users(current_user: Dict = Depends(require_admin)):
    """List all users (admin only).

    Returns:
        List of user objects.
    """
    if not ENTERPRISE_AVAILABLE:
        return []
    return await users_module.list_users()


@app.post("/api/admin/users")
async def api_create_user(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_admin),
):
    """Create a new user account.

    Args:
        payload: {email, display_name, password, role}

    Returns:
        {success, user_id} or {success: false, error}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")
    result = await users_module.create_user(
        email=payload.get("email", ""),
        display_name=payload.get("display_name", ""),
        password=payload.get("password", ""),
        role=payload.get("role", "viewer"),
        created_by=current_user["id"],
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    await audit.log_action(
        "user.create", user_id=current_user["id"], user_email=current_user["email"],
        resource_type="user", resource_id=str(result.get("user_id")),
        ip_address=get_client_ip(request),
        details={"email": payload.get("email"), "role": payload.get("role")},
    )
    return result


@app.put("/api/admin/users/{user_id}")
async def api_update_user(
    user_id: int,
    request: Request,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_admin),
):
    """Update user fields.

    Args:
        user_id: Target user database ID.
        payload: Fields to update (email, display_name, role, is_active, password, unlock).

    Returns:
        {success} or {success: false, error}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")
    result = await users_module.update_user(user_id, payload, updated_by=current_user["id"])
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    await audit.log_action(
        "user.update", user_id=current_user["id"], user_email=current_user["email"],
        resource_type="user", resource_id=str(user_id), ip_address=get_client_ip(request),
        details={"updated_fields": list(payload.keys())},
    )
    return result


@app.delete("/api/admin/users/{user_id}")
async def api_delete_user(
    user_id: int,
    request: Request,
    current_user: Dict = Depends(require_admin),
):
    """Deactivate a user account.

    Args:
        user_id: Target user database ID.

    Returns:
        {success} or {success: false, error}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")
    result = await users_module.delete_user(user_id, current_user["id"])
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    await audit.log_action(
        "user.deactivate", user_id=current_user["id"], user_email=current_user["email"],
        resource_type="user", resource_id=str(user_id), ip_address=get_client_ip(request),
    )
    return result


# ─── Fleet Management ──────────────────────────────────────────────────────────

@app.get("/api/fleet/servers")
async def api_list_servers(
    q: Optional[str] = Query(None),
    group_id: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    """List all fleet servers with optional search.

    Args:
        q: Search query (hostname, IP, display name, tags).
        group_id: Filter by server group UUID.

    Returns:
        List of server dicts with live status and snapshot data.
    """
    if not ENTERPRISE_AVAILABLE:
        return []
    return await fleet_module.list_servers(search=q, group_id=group_id)


@app.get("/api/fleet/servers/{server_id}")
async def api_get_server(server_id: str, current_user: Dict = Depends(get_auth_user)):
    """Get detailed server information including latest snapshot.

    Returns:
        Server dict or 404.
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    srv = await fleet_module.get_server(server_id)
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    return srv


@app.post("/api/fleet/servers")
async def api_register_server(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_admin),
):
    """Manually register a new server in the fleet.

    Args:
        payload: {hostname, host_ip, display_name, agent_port, tags, notes}

    Returns:
        {success, server_id, agent_token}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    result = await fleet_module.register_server(
        hostname=payload.get("hostname", ""),
        host_ip=payload.get("host_ip", ""),
        display_name=payload.get("display_name"),
        agent_port=int(payload.get("agent_port", 3500)),
        tags=payload.get("tags", []),
        notes=payload.get("notes"),
        added_by=current_user["id"],
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    await audit.log_action(
        "fleet.server.add", user_id=current_user["id"], user_email=current_user["email"],
        resource_type="server", resource_id=result.get("server_id"),
        ip_address=get_client_ip(request),
        details={"hostname": payload.get("hostname"), "host_ip": payload.get("host_ip")},
    )
    return result


@app.put("/api/fleet/servers/{server_id}")
async def api_update_server(
    server_id: str,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_admin),
):
    """Update server metadata."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    result = await fleet_module.update_server(server_id, payload)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error"))
    return result


@app.delete("/api/fleet/servers/{server_id}")
async def api_delete_server(
    server_id: str,
    request: Request,
    current_user: Dict = Depends(require_admin),
):
    """Remove a server from the fleet registry.

    Returns:
        {success}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    result = await fleet_module.delete_server(server_id)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error"))
    await audit.log_action(
        "fleet.server.remove", user_id=current_user["id"], user_email=current_user["email"],
        resource_type="server", resource_id=server_id, ip_address=get_client_ip(request),
    )
    return result


@app.get("/api/fleet/servers/{server_id}/metrics")
async def api_server_metrics(
    server_id: str,
    metric: str = Query("cpu_percent"),
    range: int = Query(24),
    current_user: Dict = Depends(get_auth_user),
):
    """Fetch historical metrics for a server.

    Args:
        server_id: Server UUID.
        metric: Metric column name (cpu_percent, mem_percent, etc.).
        range: Hours of history (default 24).

    Returns:
        List of {time_bucket, avg_value, max_value} dicts.
    """
    if not ENTERPRISE_AVAILABLE:
        return []
    return await fleet_module.get_server_metrics_history(server_id, metric, range)


# ─── Agent Registration & Heartbeat ──────────────────────────────────────────

@app.post("/api/fleet/register")
async def api_agent_register(payload: Dict[str, Any] = Body(...)):
    """Auto-register a new agent using a one-time invite token.

    Args:
        payload: {invite_token, hostname, host_ip, agent_port, os_info, arch}

    Returns:
        {success, server_id, agent_token}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    token = payload.get("invite_token")
    if not token:
        raise HTTPException(status_code=400, detail="invite_token required")

    invite = await fleet_module.consume_invite_token(token)
    if not invite:
        raise HTTPException(status_code=403, detail="Invalid, expired, or already used invite token")

    result = await fleet_module.register_server(
        hostname=payload.get("hostname", "unknown"),
        host_ip=payload.get("host_ip", ""),
        agent_port=int(payload.get("agent_port", 3501)),
        os_info=payload.get("os_info"),
        arch=payload.get("arch"),
        added_by=invite.get("created_by"),
    )
    return result


@app.post("/api/fleet/heartbeat")
async def api_agent_heartbeat(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    x_agent_token: str = Header(default=""),
):
    """Process a telemetry heartbeat from a registered agent.

    Args:
        payload: Telemetry data dict (cpu, mem, disk, rx_sec, tx_sec, load1, uptime).
        x_agent_token: Agent authentication token from header.

    Returns:
        {success, server_id, status}
    """
    if not ENTERPRISE_AVAILABLE:
        return {"success": True}
    token = x_agent_token or payload.get("agent_token", "")
    if not token:
        raise HTTPException(status_code=401, detail="X-Agent-Token header required")
    result = await fleet_module.process_heartbeat(token, payload)
    if not result["success"]:
        raise HTTPException(status_code=403, detail=result.get("error"))
    return result


@app.get("/api/fleet/agent-download")
async def api_agent_download():
    """Serve the agent script for download during installation."""
    agent_path = os.path.join(os.path.dirname(__file__), "pulseops_agent.py")
    if os.path.exists(agent_path):
        return FileResponse(agent_path, media_type="text/plain", filename="pulseops_agent.py")
    raise HTTPException(status_code=404, detail="Agent script not found")


@app.get("/api/fleet/agent-install.sh")
async def api_agent_install_script(
    request: Request,
    token: str = Query(...),
):
    """Generate and serve the agent installation shell script.

    Args:
        token: One-time invite token UUID to embed in the script.

    Returns:
        Shell script as plain text.
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    host = request.headers.get("host", f"localhost:{os.environ.get('PORT', 3500)}")
    proto = request.headers.get("x-forwarded-proto", "http")
    default_url = f"{proto}://{host}"
    master_url = MASTER_URL or (await database.get_setting("master_url", default_url))
    if not master_url:
        master_url = default_url
    script = fleet_module.get_agent_install_script(master_url, token)
    return PlainTextResponse(script, media_type="text/x-shellscript")


# ─── Invite Tokens ────────────────────────────────────────────────────────────

@app.post("/api/fleet/invite-tokens")
async def api_create_invite_token(
    payload: Dict[str, Any] = Body(default={}),
    current_user: Dict = Depends(require_admin),
):
    """Generate a new one-time agent invite token.

    Args:
        payload: {expires_hours} (optional, default 24)

    Returns:
        {token, expires_at}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    expires_hours = int(payload.get("expires_hours", 24))
    return await fleet_module.create_invite_token(current_user["id"], expires_hours)


@app.get("/api/fleet/invite-tokens")
async def api_list_invite_tokens(current_user: Dict = Depends(require_admin)):
    """List active invite tokens."""
    if not ENTERPRISE_AVAILABLE:
        return []
    return await fleet_module.list_invite_tokens()


@app.delete("/api/fleet/invite-tokens/{token}")
async def api_revoke_invite_token(token: str, current_user: Dict = Depends(require_admin)):
    """Revoke an invite token."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    return await fleet_module.revoke_invite_token(token)


# ─── Alert Rules ──────────────────────────────────────────────────────────────

@app.get("/api/alerts/rules")
async def api_list_alert_rules(
    server_id: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    """List alert rules."""
    if not ENTERPRISE_AVAILABLE:
        return []
    return await alerts_module.list_alert_rules(server_id)


@app.post("/api/alerts/rules")
async def api_create_alert_rule(
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_admin),
):
    """Create a new alert rule."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    result = await alerts_module.create_alert_rule(
        name=payload.get("name", ""),
        metric=payload.get("metric", "cpu_percent"),
        operator=payload.get("operator", "gt"),
        threshold=payload.get("threshold"),
        severity=payload.get("severity", "warning"),
        server_id=payload.get("server_id"),
        notify_email=payload.get("notify_email", False),
        notify_webhook=payload.get("notify_webhook", False),
        webhook_url=payload.get("webhook_url"),
        created_by=current_user["id"],
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.delete("/api/alerts/rules/{rule_id}")
async def api_delete_alert_rule(rule_id: int, current_user: Dict = Depends(require_admin)):
    """Deactivate an alert rule."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    return await alerts_module.delete_alert_rule(rule_id)


@app.get("/api/alerts/active")
async def api_active_alerts(
    server_id: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    """List currently active (firing) alerts."""
    if not ENTERPRISE_AVAILABLE:
        return []
    return await alerts_module.get_active_alerts(server_id)


@app.get("/api/alerts/history")
async def api_alert_history(
    limit: int = Query(100),
    current_user: Dict = Depends(get_auth_user),
):
    """List recent alert history (fired and resolved)."""
    if not ENTERPRISE_AVAILABLE:
        return []
    return await alerts_module.get_all_alerts(limit)


# ─── Audit Log ────────────────────────────────────────────────────────────────

@app.get("/api/admin/audit")
async def api_audit_log(
    page: int = Query(1),
    page_size: int = Query(50),
    user_filter: Optional[str] = Query(None),
    action_filter: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    result_filter: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    current_user: Dict = Depends(require_admin),
):
    """Return paginated audit log with filters."""
    if not ENTERPRISE_AVAILABLE:
        return {"entries": [], "total": 0, "page": 1, "page_size": 50, "pages": 1}
    return await audit.get_audit_log(
        page=page, page_size=page_size,
        user_filter=user_filter, action_filter=action_filter,
        resource_type_filter=resource_type, result_filter=result_filter,
        date_from=date_from, date_to=date_to,
    )


@app.get("/api/admin/audit/recent")
async def api_recent_activity(
    limit: int = Query(20),
    current_user: Dict = Depends(get_auth_user),
):
    """Return recent audit log activity feed."""
    if not ENTERPRISE_AVAILABLE:
        return []
    return await audit.get_recent_activity(limit)


# ─── Settings ─────────────────────────────────────────────────────────────────

@app.get("/api/admin/settings")
async def api_get_settings(current_user: Dict = Depends(require_admin)):
    """Return all system settings."""
    if not ENTERPRISE_AVAILABLE:
        return {}
    rows = await database.fetchall(
        "SELECT key, value, type FROM settings ORDER BY key ASC"
    )
    result = {}
    for row in rows:
        # Mask sensitive fields
        if row["key"] in ("smtp_password",):
            result[row["key"]] = "••••••••" if row["value"] else ""
        else:
            result[row["key"]] = row["value"]
    return result


@app.put("/api/admin/settings")
async def api_update_settings(
    payload: Dict[str, str] = Body(...),
    current_user: Dict = Depends(require_admin),
):
    """Update one or more system settings.

    Args:
        payload: Dict of {key: value} settings to update.

    Returns:
        {success, updated_count}
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    allowed_keys = {
        "app_name", "session_timeout_hours", "agent_poll_interval",
        "snapshot_retention_hours", "smtp_host", "smtp_port", "smtp_username",
        "smtp_password", "smtp_from", "global_cpu_alert_threshold",
        "global_mem_alert_threshold", "global_disk_alert_threshold", "master_url",
    }
    count = 0
    for key, value in payload.items():
        if key in allowed_keys:
            await database.set_setting(key, str(value), current_user["id"])
            count += 1
    await audit.log_action(
        "settings.update", user_id=current_user["id"], user_email=current_user["email"],
        details={"keys": [k for k in payload if k in allowed_keys]},
    )
    return {"success": True, "updated_count": count}


# ─── Telemetry (local server snapshot) ───────────────────────────────────────

@app.get("/api/telemetry/snapshot")
async def api_telemetry_snapshot(request: Request):
    """Return current telemetry as a flat snapshot (used by fleet polling)."""
    data = await telemetry.get_full_telemetry()
    return {
        "cpu": data["cpu"],
        "mem": data["memory"]["usagePercent"],
        "disk": data["disks"][0]["usagePercent"] if data["disks"] else 0,
        "rx_sec": data["network"]["rxSec"],
        "tx_sec": data["network"]["txSec"],
        "load1": data["sysInfo"]["loadAvg"][0] if data["sysInfo"]["loadAvg"] else 0,
        "uptime": data["sysInfo"]["uptime"],
        "hostname": data["sysInfo"]["hostname"],
        "os_info": data["sysInfo"]["osName"],
        "arch": data["sysInfo"]["arch"],
    }


# ─── Existing Service/Process/Terminal/VNC APIs ───────────────────────────────

@app.get("/api/services")
async def api_get_services(current_user: Dict = Depends(get_auth_user)):
    return await services.get_services()


@app.post("/api/services/action")
async def api_action_service(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    service_name = payload.get("serviceName")
    action = payload.get("action")
    res = await services.action_service(service_name, action)
    if ENTERPRISE_AVAILABLE:
        await audit.log_action(
            f"service.{action}", user_id=current_user["id"], user_email=current_user["email"],
            resource_type="service", resource_id=service_name, ip_address=get_client_ip(request),
            result="success" if res.get("success") else "failure",
        )
    if not res.get("success"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.get("/api/services/{name}/logs")
async def api_service_logs(name: str, current_user: Dict = Depends(get_auth_user)):
    return await services.get_service_logs(name)


@app.get("/api/processes")
async def api_get_processes(current_user: Dict = Depends(get_auth_user)):
    return await processes.get_processes()


@app.post("/api/processes/kill")
async def api_kill_process(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    pid = payload.get("pid")
    signal_val = payload.get("signal", "15")
    res = await processes.kill_process(pid, signal_val)
    if ENTERPRISE_AVAILABLE:
        await audit.log_action(
            "process.kill", user_id=current_user["id"], user_email=current_user["email"],
            resource_type="process", resource_id=str(pid), ip_address=get_client_ip(request),
            details={"signal": signal_val},
            result="success" if res.get("success") else "failure",
        )
    if not res.get("success"):
        return JSONResponse(status_code=400, content=res)
    return res


@app.post("/api/terminal/exec")
async def api_exec_terminal(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    command = payload.get("command")
    sudo_pass = payload.get("sudoPassword")
    res = await terminal.exec_terminal_command(command, sudo_pass)
    if ENTERPRISE_AVAILABLE:
        await audit.log_action(
            "terminal.exec", user_id=current_user["id"], user_email=current_user["email"],
            resource_type="terminal", ip_address=get_client_ip(request),
            details={"command": command[:200] if command else ""},
        )
    return res


@app.get("/api/vnc/status")
async def api_vnc_status(host: str = "127.0.0.1", current_user: Dict = Depends(get_auth_user)):
    return await vnc.get_vnc_status(host)


@app.post("/api/vnc/launch")
async def api_vnc_launch(
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    display = payload.get("display", ":0")
    port = int(payload.get("port", 5900))
    use_native = bool(payload.get("useNative", False))
    return await vnc.launch_vnc(display, port, use_native)


# ─── Fleet Server Proxy Routes ────────────────────────────────────────────────

@app.get("/api/fleet/{server_id}/services")
async def api_proxy_services(server_id: str, current_user: Dict = Depends(get_auth_user)):
    """Proxy: get services from a remote fleet server agent."""
    return await _proxy_get(server_id, "/api/services")


@app.post("/api/fleet/{server_id}/services/action")
async def api_proxy_service_action(
    server_id: str,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    """Proxy: perform service action on a remote fleet server."""
    return await _proxy_post(server_id, "/api/services/action", payload)


@app.get("/api/fleet/{server_id}/processes")
async def api_proxy_processes(server_id: str, current_user: Dict = Depends(get_auth_user)):
    """Proxy: list processes on a remote fleet server."""
    return await _proxy_get(server_id, "/api/processes")


@app.post("/api/fleet/{server_id}/terminal/exec")
async def api_proxy_terminal(
    server_id: str,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    """Proxy: execute terminal command on a remote fleet server."""
    return await _proxy_post(server_id, "/api/terminal/exec", payload)


async def _proxy_get(server_id: str, path: str) -> Any:
    """Proxy a GET request to a fleet server agent.

    Args:
        server_id: Server UUID.
        path: API path to proxy to.

    Returns:
        JSON response from the agent.
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    srv = await fleet_module.get_server(server_id)
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    url = f"http://{srv['host_ip']}:{srv['agent_port']}{path}"
    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            headers = {"X-Agent-Token": srv.get("agent_token", "")}
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10), headers=headers) as resp:
                return await resp.json()
    except ImportError:
        raise HTTPException(status_code=503, detail="aiohttp required for proxying")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Agent unreachable: {e}")


async def _proxy_post(server_id: str, path: str, data: Dict) -> Any:
    """Proxy a POST request to a fleet server agent.

    Args:
        server_id: Server UUID.
        path: API path to proxy to.
        data: JSON body to forward.

    Returns:
        JSON response from the agent.
    """
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    srv = await fleet_module.get_server(server_id)
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    url = f"http://{srv['host_ip']}:{srv['agent_port']}{path}"
    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            headers = {"X-Agent-Token": srv.get("agent_token", "")}
            async with session.post(url, json=data, timeout=aiohttp.ClientTimeout(total=10), headers=headers) as resp:
                return await resp.json()
    except ImportError:
        raise HTTPException(status_code=503, detail="aiohttp required for proxying")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Agent unreachable: {e}")


# ─── WebSocket Endpoints ──────────────────────────────────────────────────────

@app.websocket("/")
async def websocket_telemetry_endpoint(websocket: WebSocket):
    """WebSocket: push real-time telemetry to connected browser clients."""
    await websocket.accept()
    connected_clients.add(websocket)
    try:
        initial_data = await telemetry.get_full_telemetry()
        await websocket.send_text(json.dumps({"type": "telemetry", "data": initial_data}))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        connected_clients.discard(websocket)


@app.websocket("/api/vnc/ws")
async def websocket_vnc_proxy(websocket: WebSocket, host: str = "127.0.0.1", port: int = 5900):
    """WebSocket: proxy RFB traffic to a VNC server."""
    await websocket.accept()
    try:
        reader, writer = await asyncio.open_connection(host, port)
        await websocket.send_text(json.dumps({
            "type": "vnc_proxy_meta", "status": "connected", "host": host, "port": port
        }))

        async def forward_tcp():
            try:
                while not reader.at_eof():
                    data = await reader.read(4096)
                    if not data:
                        break
                    await websocket.send_bytes(data)
            except Exception:
                pass

        asyncio.create_task(forward_tcp())
        while True:
            msg = await websocket.receive()
            if "bytes" in msg and msg["bytes"]:
                writer.write(msg["bytes"])
                await writer.drain()
            elif "text" in msg and msg["text"]:
                writer.write(msg["text"].encode("utf-8"))
                await writer.drain()
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({
                "type": "vnc_proxy_meta", "status": "error", "error": str(e)
            }))
        except Exception:
            pass


# ─── Startup / Shutdown ───────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    """Initialize database, bootstrap admin, and start background tasks."""
    if ENTERPRISE_AVAILABLE:
        await database.init_db()
        await auth.bootstrap_admin()
        await fleet_module.ensure_local_server(int(os.environ.get("PORT", 3500)))
        fleet_module.set_broadcast_callback(_fleet_broadcast)
        asyncio.create_task(fleet_module.fleet_health_poll_loop())

    asyncio.create_task(_telemetry_loop())
    asyncio.create_task(_log_stream_loop())


async def _fleet_broadcast(payload: Dict[str, Any]) -> None:
    """Broadcast a fleet status update to all connected WebSocket clients."""
    msg = json.dumps(payload)
    for client in list(connected_clients):
        try:
            await client.send_text(msg)
        except Exception:
            connected_clients.discard(client)


async def _telemetry_loop():
    """Background task: push local telemetry to WebSocket clients every 2s."""
    while True:
        await asyncio.sleep(2.0)
        try:
            data = await telemetry.get_full_telemetry()
            if ENTERPRISE_AVAILABLE:
                try:
                    fleet_module.update_local_snapshot("local-master", data)
                except Exception:
                    pass
            if connected_clients:
                payload = json.dumps({"type": "telemetry", "data": data})
                for client in list(connected_clients):
                    try:
                        await client.send_text(payload)
                    except Exception:
                        connected_clients.discard(client)
        except Exception as e:
            pass


async def _log_stream_loop():
    """Background task: push simulated system log entries every 3s."""
    log_levels = ['INFO', 'DEBUG', 'WARN', 'ERROR']
    log_sources = ['kernel', 'systemd-journald', 'sshd', 'nginx', 'dockerd', 'cron']
    sample_messages = [
        'Connection accepted from 192.168.1.105:49210',
        'DHCP lease renewed on interface eth0',
        'Periodic cron job /usr/bin/certbot executed successfully',
        'GET /api/v1/telemetry 200 OK - 12ms',
        'Memory page cache flushed',
        'SSL handshake completed for host admin.pulseops.local',
        'CPU frequency scaled to peak governor mode',
        'Disk I/O flush completed in 4.2ms'
    ]
    while True:
        await asyncio.sleep(3.0)
        if connected_clients:
            log_entry = {
                "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                "level": random.choice(log_levels),
                "source": random.choice(log_sources),
                "message": random.choice(sample_messages)
            }
            payload = json.dumps({"type": "logStream", "data": log_entry})
            for client in list(connected_clients):
                try:
                    await client.send_text(payload)
                except Exception:
                    connected_clients.discard(client)
