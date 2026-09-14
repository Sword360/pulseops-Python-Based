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
from typing import Any, Dict, Optional

from fastapi import (
    FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body,
    Depends, Header, Query, Request
)
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

import telemetry
import services
import processes
import terminal
import vnc
import docker_manager
import ports_manager
import commands_manager
import maintenance_manager

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

    db_user = await users_module.get_user_by_email(email)
    if not db_user or not db_user.get("is_active"):
        await audit.log_action("auth.login", user_email=email, ip_address=ip, result="failure",
                               details={"reason": "invalid_credentials"})
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if db_user.get("locked_until"):
        try:
            lock_dt = datetime.fromisoformat(db_user["locked_until"])
            if lock_dt.tzinfo is None:
                lock_dt = lock_dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < lock_dt:
                await audit.log_action("auth.login", user_email=email, ip_address=ip, result="failure",
                                       details={"reason": "account_locked", "locked_until": db_user.get("locked_until")})
                raise HTTPException(status_code=423, detail=f"Account locked until {db_user.get('locked_until')}")
        except Exception:
            pass

    if not users_module.verify_password(password, db_user["password_hash"]):
        await auth.record_failed_login(db_user["id"], email, ip)
        await audit.log_action("auth.login", user_email=email, ip_address=ip, result="failure",
                               details={"reason": "invalid_credentials"})
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user = db_user

    # TOTP check if enabled
    if user.get("totp_enabled"):
        if not totp_code:
            return JSONResponse({"totp_required": True}, status_code=200)
        if not await auth.verify_totp_or_backup(user, totp_code):
            await auth.record_failed_login(user["id"], email, ip)
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


@app.post("/api/auth/2fa/setup")
async def api_2fa_setup(current_user: Dict = Depends(get_auth_user)):
    """Initialize TOTP 2FA setup and return secret, otpauth URI, and QR code."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")
    import pyotp
    import io
    import base64
    import qrcode

    secret = pyotp.random_base32()
    await database.execute(
        "UPDATE users SET totp_secret = ? WHERE id = ?",
        (secret, current_user["id"])
    )

    otpauth_uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=current_user["email"],
        issuer_name="PulseOps"
    )

    qr_img = qrcode.make(otpauth_uri)
    buf = io.BytesIO()
    qr_img.save(buf, format="PNG")
    qr_data_url = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('utf-8')}"

    return {
        "success": True,
        "secret": secret,
        "otpauth_uri": otpauth_uri,
        "qr_data_url": qr_data_url,
    }


@app.post("/api/auth/2fa/verify")
async def api_2fa_verify(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(get_auth_user),
):
    """Verify code and finalize TOTP 2FA setup, generating backup codes."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")
    import secrets
    import pyotp

    code = payload.get("code", "").strip()
    if not code or len(code) != 6:
        raise HTTPException(status_code=400, detail="A valid 6-digit code is required")

    u = await users_module.get_user_by_id(current_user["id"])
    secret = u.get("totp_secret") if u else None
    if not secret:
        raise HTTPException(status_code=400, detail="2FA setup not initiated")

    totp = pyotp.TOTP(secret)
    if not totp.verify(code):
        raise HTTPException(status_code=400, detail="Invalid 2FA code")

    # Generate 8 recovery backup codes (XXXX-XXXX format)
    backup_codes = [f"{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}" for _ in range(8)]
    await users_module.update_user_totp(
        user_id=current_user["id"],
        secret=secret,
        enabled=True,
        backup_codes=json.dumps(backup_codes)
    )

    await audit.log_action(
        "auth.2fa.enable",
        user_id=current_user["id"],
        user_email=current_user["email"],
        ip_address=get_client_ip(request),
    )

    return {"success": True, "backup_codes": backup_codes}


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


@app.get("/api/fleet/servers/{server_id}/snapshots")
async def api_server_snapshots(
    server_id: str,
    limit: int = Query(30),
    current_user: Dict = Depends(get_auth_user),
):
    """Return recent raw telemetry snapshots for a server."""
    if not ENTERPRISE_AVAILABLE:
        return {"success": True, "snapshots": []}
    snapshots = await fleet_module.get_recent_snapshots(server_id, limit)
    return {"success": True, "snapshots": snapshots}


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


@app.get("/api/fleet/agent-update.sh")
async def api_agent_update_script(request: Request):
    """Generate and serve the agent update shell script."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503)
    host = request.headers.get("host", f"localhost:{os.environ.get('PORT', 3500)}")
    proto = request.headers.get("x-forwarded-proto", "http")
    default_url = f"{proto}://{host}"
    master_url = MASTER_URL or (await database.get_setting("master_url", default_url))
    if not master_url:
        master_url = default_url
    script = fleet_module.get_agent_update_script(master_url)
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


@app.post("/api/admin/settings/test-smtp")
async def api_test_smtp(current_user: Dict = Depends(require_admin)):
    """Send a test email using configured SMTP settings."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")
    result = await alerts_module.send_test_email()
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Failed to send test email"))
    return result


@app.get("/api/admin/backup")
async def api_backup_db(current_user: Dict = Depends(require_admin)):
    """Download database backup file."""
    if not ENTERPRISE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Enterprise modules not available")
    db_path = database.DB_PATH if hasattr(database, "DB_PATH") else os.path.join(os.path.dirname(__file__), "pulseops.db")
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail="Database file not found")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    filename = f"pulseops-backup-{today}.db"
    return FileResponse(db_path, media_type="application/octet-stream", filename=filename)


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
async def api_get_services(
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/services", "GET")
        return JSONResponse(status_code=code, content=data)
    return await services.get_services()


@app.post("/api/services/action")
async def api_action_service(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(require_operator),
):
    target_server = payload.get("server_id") or payload.get("serverId") or server_id or serverId
    service_name = payload.get("serviceName")
    action = payload.get("action")
    if target_server and target_server != "local-master":
        res, code = await proxy_to_agent(target_server, "/api/services/action", "POST", json_body=payload)
        if ENTERPRISE_AVAILABLE:
            await audit.log_action(
                f"service.{action}", user_id=current_user["id"], user_email=current_user["email"],
                resource_type="service", resource_id=service_name, ip_address=get_client_ip(request),
                details={"server_id": target_server},
                result="success" if (isinstance(res, dict) and res.get("success")) else "failure",
            )
    else:
        res = await services.action_service(service_name, action)
        code = 200 if res.get("success") else 400
        if ENTERPRISE_AVAILABLE:
            await audit.log_action(
                f"service.{action}", user_id=current_user["id"], user_email=current_user["email"],
                resource_type="service", resource_id=service_name, ip_address=get_client_ip(request),
                result="success" if (isinstance(res, dict) and res.get("success")) else "failure",
            )
    return JSONResponse(status_code=code, content=res)


@app.get("/api/services/{name}/logs")
async def api_service_logs(
    name: str,
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    lines: int = Query(100),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/services/logs", "GET", query_params={"service": name, "lines": str(lines)})
        return JSONResponse(status_code=code, content=data)
    return await services.get_service_logs(name)


@app.get("/api/services/logs")
async def api_services_logs_query(
    service: str = Query(...),
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    lines: int = Query(100),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/services/logs", "GET", query_params={"service": service, "lines": str(lines)})
        return JSONResponse(status_code=code, content=data)
    return await services.get_service_logs(service)


@app.get("/api/processes")
async def api_get_processes(
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/processes", "GET")
        return JSONResponse(status_code=code, content=data)
    return await processes.get_processes()


@app.post("/api/processes/kill")
async def api_kill_process(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(require_operator),
):
    target_server = payload.get("server_id") or payload.get("serverId") or server_id or serverId
    pid = payload.get("pid")
    signal_val = payload.get("signal", "15")
    if target_server and target_server != "local-master":
        res, code = await proxy_to_agent(target_server, "/api/processes/kill", "POST", json_body=payload)
        if ENTERPRISE_AVAILABLE:
            await audit.log_action(
                "process.kill", user_id=current_user["id"], user_email=current_user["email"],
                resource_type="process", resource_id=str(pid), ip_address=get_client_ip(request),
                details={"signal": signal_val, "server_id": target_server},
                result="success" if (isinstance(res, dict) and res.get("success")) else "failure",
            )
    else:
        res = await processes.kill_process(pid, signal_val)
        code = 200 if res.get("success") else 400
        if ENTERPRISE_AVAILABLE:
            await audit.log_action(
                "process.kill", user_id=current_user["id"], user_email=current_user["email"],
                resource_type="process", resource_id=str(pid), ip_address=get_client_ip(request),
                details={"signal": signal_val},
                result="success" if (isinstance(res, dict) and res.get("success")) else "failure",
            )
    return JSONResponse(status_code=code, content=res)


# ─── Docker Container Management Endpoints ──────────────────────────────────

@app.get("/api/docker/status")
async def api_docker_status(
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/docker/status", "GET")
        return JSONResponse(status_code=code, content=data)
    return await docker_manager.is_docker_available()


@app.get("/api/docker/containers")
async def api_get_containers(
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    all: bool = Query(True),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/docker/containers", "GET")
        return JSONResponse(status_code=code, content=data)
    return await docker_manager.get_containers(all_containers=all)


@app.post("/api/docker/action")
async def api_action_container(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(require_operator),
):
    target_server = payload.get("server_id") or payload.get("serverId") or server_id or serverId
    cid = payload.get("container_id") or payload.get("container") or ""
    action = payload.get("action") or ""
    if target_server and target_server != "local-master":
        res, code = await proxy_to_agent(target_server, "/api/docker/action", "POST", json_body=payload)
        if ENTERPRISE_AVAILABLE:
            await audit.log_action(
                f"docker.{action}", user_id=current_user["id"], user_email=current_user["email"],
                resource_type="container", resource_id=str(cid), ip_address=get_client_ip(request),
                details={"server_id": target_server, "action": action},
                result="success" if (isinstance(res, dict) and res.get("success")) else "failure",
            )
    else:
        res = await docker_manager.action_container(cid, action)
        code = 200 if res.get("success") else 400
        if ENTERPRISE_AVAILABLE:
            await audit.log_action(
                f"docker.{action}", user_id=current_user["id"], user_email=current_user["email"],
                resource_type="container", resource_id=str(cid), ip_address=get_client_ip(request),
                details={"action": action},
                result="success" if res.get("success") else "failure",
            )
    return JSONResponse(status_code=code, content=res)


@app.get("/api/docker/logs")
async def api_container_logs(
    container: Optional[str] = Query(None),
    container_id: Optional[str] = Query(None),
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    lines: int = Query(100),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    cid = container or container_id or ""
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/docker/logs", "GET", query_params={"container": cid, "lines": str(lines)})
        return JSONResponse(status_code=code, content=data)
    return await docker_manager.get_container_logs(cid, lines=lines)


@app.get("/api/docker/inspect")
async def api_inspect_container(
    container: Optional[str] = Query(None),
    container_id: Optional[str] = Query(None),
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    cid = container or container_id or ""
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/docker/inspect", "GET", query_params={"container": cid})
        return JSONResponse(status_code=code, content=data)
    return await docker_manager.inspect_container(cid)


# ─── Network Listening Ports Endpoints ──────────────────────────────────────

@app.get("/api/network/ports")
async def api_network_ports(
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/network/ports", "GET")
        return JSONResponse(status_code=code, content=data)
    return await ports_manager.get_listening_ports()


# ─── Saved Commands & Runbooks Endpoints ────────────────────────────────────

@app.get("/api/commands")
async def api_list_commands(
    current_user: Dict = Depends(get_auth_user),
):
    user_role = current_user.get("role", "viewer")
    cmds = await commands_manager.list_commands(user_role)
    return {"success": True, "commands": cmds}


@app.post("/api/commands")
async def api_create_command(
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    res = await commands_manager.create_command(
        payload.get("name", ""), payload.get("description", ""),
        payload.get("command", ""), bool(payload.get("requires_sudo", False)),
        payload.get("allowed_roles", ["admin", "operator"]),
        created_by=current_user.get("id", 1)
    )
    code = 200 if res.get("success") else 400
    return JSONResponse(status_code=code, content=res)


@app.put("/api/commands/{command_id}")
async def api_update_command(
    command_id: int,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    res = await commands_manager.update_command(
        command_id, payload.get("name", ""), payload.get("description", ""),
        payload.get("command", ""), bool(payload.get("requires_sudo", False)),
        payload.get("allowed_roles", ["admin", "operator"])
    )
    code = 200 if res.get("success") else 400
    return JSONResponse(status_code=code, content=res)


@app.delete("/api/commands/{command_id}")
async def api_delete_command(
    command_id: int,
    current_user: Dict = Depends(require_operator),
):
    res = await commands_manager.delete_command(command_id)
    code = 200 if res.get("success") else 400
    return JSONResponse(status_code=code, content=res)


@app.post("/api/commands/{command_id}/execute")
async def api_execute_command(
    request: Request,
    command_id: int,
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(get_auth_user),
):
    cmd_obj = await commands_manager.get_command(command_id)
    if not cmd_obj:
        return JSONResponse(status_code=404, content={"detail": "Command not found"})

    user_role = current_user.get("role", "viewer")
    if user_role not in cmd_obj.get("allowed_roles", []) and user_role != "admin":
        return JSONResponse(status_code=403, content={"detail": "Role not authorized to run this runbook"})

    target_server = payload.get("server_id") or payload.get("serverId")
    sudo_pass = payload.get("sudoPassword", "")
    cmd_text = cmd_obj["command"]

    for k, v in (payload.get("params") or {}).items():
        cmd_text = cmd_text.replace(f"{{{{{k}}}}}", str(v))

    if target_server and target_server != "local-master":
        res_data, code = await proxy_to_agent(target_server, "/api/terminal/exec", "POST", json_body={"command": cmd_text, "sudoPassword": sudo_pass})
        if ENTERPRISE_AVAILABLE:
            await audit.log_action(
                "runbook.exec", user_id=current_user["id"], user_email=current_user["email"],
                resource_type="command", resource_id=str(command_id), ip_address=get_client_ip(request),
                details={"command": cmd_obj["name"], "server_id": target_server}
            )
        return JSONResponse(status_code=code, content=res_data)

    res_data = await terminal.exec_terminal_command(cmd_text, sudo_pass)
    if ENTERPRISE_AVAILABLE:
        await audit.log_action(
            "runbook.exec", user_id=current_user["id"], user_email=current_user["email"],
            resource_type="command", resource_id=str(command_id), ip_address=get_client_ip(request),
            details={"command": cmd_obj["name"]}
        )
    return JSONResponse(status_code=200 if res_data.get("exit_code") == 0 else 400, content=res_data)


# ─── Maintenance Windows & Groups Endpoints ─────────────────────────────────

@app.get("/api/maintenance/windows")
async def api_list_maintenance_windows(
    server_id: Optional[str] = Query(None),
    current_user: Dict = Depends(get_auth_user),
):
    windows = await maintenance_manager.list_maintenance_windows(server_id)
    return {"success": True, "windows": windows}


@app.post("/api/maintenance/windows")
async def api_create_maintenance_window(
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_operator),
):
    res = await maintenance_manager.create_maintenance_window(
        payload.get("server_id", ""), payload.get("start_time", ""),
        payload.get("end_time", ""), payload.get("reason", ""),
        created_by=current_user.get("id", 1)
    )
    code = 200 if res.get("success") else 400
    return JSONResponse(status_code=code, content=res)


@app.delete("/api/maintenance/windows/{window_id}")
async def api_delete_maintenance_window(
    window_id: int,
    current_user: Dict = Depends(require_operator),
):
    res = await maintenance_manager.delete_maintenance_window(window_id)
    code = 200 if res.get("success") else 400
    return JSONResponse(status_code=code, content=res)


@app.get("/api/maintenance/groups")
async def api_list_server_groups():
    groups = await maintenance_manager.list_server_groups()
    return {"success": True, "groups": groups}


@app.post("/api/maintenance/groups")
async def api_create_server_group(
    payload: Dict[str, Any] = Body(...),
    current_user: Dict = Depends(require_admin),
):
    res = await maintenance_manager.create_server_group(
        payload.get("id", ""), payload.get("name", ""),
        payload.get("color", ""), payload.get("description", "")
    )
    code = 200 if res.get("success") else 400
    return JSONResponse(status_code=code, content=res)


@app.delete("/api/maintenance/groups/{group_id}")
async def api_delete_server_group(
    group_id: str,
    current_user: Dict = Depends(require_admin),
):
    res = await maintenance_manager.delete_server_group(group_id)
    code = 200 if res.get("success") else 400
    return JSONResponse(status_code=code, content=res)


@app.post("/api/terminal/exec")
async def api_exec_terminal(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    current_user: Dict = Depends(require_operator),
):
    target_server = payload.get("server_id") or payload.get("serverId") or server_id or serverId
    command = payload.get("command")
    sudo_pass = payload.get("sudoPassword")
    if target_server and target_server != "local-master":
        res, code = await proxy_to_agent(target_server, "/api/terminal/exec", "POST", json_body={"command": command, "sudoPassword": sudo_pass})
        if ENTERPRISE_AVAILABLE:
            await audit.log_action(
                "terminal.exec", user_id=current_user["id"], user_email=current_user["email"],
                resource_type="terminal", ip_address=get_client_ip(request),
                details={"command": command[:200] if command else "", "server_id": target_server},
            )
        return JSONResponse(status_code=code, content=res)
    res = await terminal.exec_terminal_command(command, sudo_pass)
    if ENTERPRISE_AVAILABLE:
        await audit.log_action(
            "terminal.exec", user_id=current_user["id"], user_email=current_user["email"],
            resource_type="terminal", ip_address=get_client_ip(request),
            details={"command": command[:200] if command else ""},
        )
    return res


@app.get("/api/logs")
async def api_get_logs(
    server_id: Optional[str] = Query(None),
    serverId: Optional[str] = Query(None),
    lines: int = Query(50),
    current_user: Dict = Depends(get_auth_user),
):
    target = server_id or serverId
    if target and target != "local-master":
        data, code = await proxy_to_agent(target, "/api/logs", "GET", query_params={"lines": str(lines)})
        return JSONResponse(status_code=code, content=data)
    return {"success": True, "logs": []}


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


async def proxy_to_agent(
    server_id: str,
    endpoint: str,
    method: str = "GET",
    json_body: Optional[Dict[str, Any]] = None,
    query_params: Optional[Dict[str, str]] = None,
) -> tuple:
    """Proxy an API request to a remote fleet agent.

    Returns (response_dict_or_content, http_status_code).
    """
    if not ENTERPRISE_AVAILABLE:
        return {"success": False, "error": "Enterprise fleet not available"}, 400

    srv = await fleet_module.get_server(server_id)
    if not srv:
        return {"success": False, "error": f"Server '{server_id}' not found"}, 404

    host_ip = srv.get("host_ip")
    port = srv.get("agent_port", 3501)
    token = srv.get("agent_token", "")
    hostname = srv.get("hostname") or srv.get("display_name") or host_ip

    try:
        import aiohttp
    except ImportError:
        return {"success": False, "error": "aiohttp not available on master"}, 500

    url = f"http://{host_ip}:{port}{endpoint}"
    req_headers = {"X-Agent-Token": token}

    try:
        timeout = aiohttp.ClientTimeout(total=8)
        async with aiohttp.ClientSession() as session:
            if method.upper() == "GET":
                async with session.get(url, params=query_params, headers=req_headers, timeout=timeout) as resp:
                    if resp.status == 404:
                        return {
                            "success": False,
                            "need_update": True,
                            "error": f"Agent on {hostname} needs to be upgraded to v2 to enable remote operations.",
                            "hostname": hostname,
                            "server_id": server_id,
                        }, 200
                    try:
                        data = await resp.json()
                        return data, resp.status
                    except Exception:
                        txt = await resp.text()
                        return {"success": False, "error": txt}, resp.status
            elif method.upper() == "POST":
                async with session.post(url, json=json_body or {}, headers=req_headers, timeout=timeout) as resp:
                    if resp.status == 404:
                        return {
                            "success": False,
                            "need_update": True,
                            "error": f"Agent on {hostname} needs to be upgraded to v2 to enable remote operations.",
                            "hostname": hostname,
                            "server_id": server_id,
                        }, 200
                    try:
                        data = await resp.json()
                        return data, resp.status
                    except Exception:
                        txt = await resp.text()
                        return {"success": False, "error": txt}, resp.status
            return {"success": False, "error": f"Unsupported method {method}"}, 405
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to reach agent at {host_ip}:{port} - {e}",
            "hostname": hostname,
            "server_id": server_id,
        }, 502


async def _proxy_get(server_id: str, path: str, params: Optional[Dict[str, str]] = None) -> Any:
    """Proxy a GET request to a fleet server agent."""
    data, code = await proxy_to_agent(server_id, path, method="GET", query_params=params)
    if code >= 400:
        detail = data.get("error", "Proxy request failed") if isinstance(data, dict) else str(data)
        raise HTTPException(status_code=code, detail=detail)
    return data


async def _proxy_post(server_id: str, path: str, data: Dict) -> Any:
    """Proxy a POST request to a fleet server agent."""
    res_data, code = await proxy_to_agent(server_id, path, method="POST", json_body=data)
    if code >= 400:
        detail = res_data.get("error", "Proxy request failed") if isinstance(res_data, dict) else str(res_data)
        raise HTTPException(status_code=code, detail=detail)
    return res_data


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
        except Exception:
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
