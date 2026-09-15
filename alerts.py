"""
alerts.py — PulseOps Enterprise Modern Alerting & Incident Response Engine.

Evaluates multi-metric alert rules against real-time server telemetry snapshots,
tracks firing, acknowledged, and resolved incident lifecycles, delivers rich
notifications via Discord, Slack, Telegram, Webhooks, and SMTP, and provides
instant bidirectional WebSocket incident updates to the dashboard.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("pulseops.alerts")

VALID_METRICS = {
    "cpu_percent",
    "mem_percent",
    "disk_percent",
    "swap_percent",
    "load_avg_1",
    "load_avg_15",
    "net_rx_mb",
    "net_tx_mb",
    "agent_offline",
    "service_down",
}

VALID_OPERATORS = {"gt", "lt", "eq"}
VALID_SEVERITIES = {"critical", "warning", "info"}
VALID_CHANNELS = {"webhook", "discord", "slack", "telegram", "email"}

# In-memory cooldown tracker: key is f"{rule_id}:{server_id}" -> timestamp
_notification_cooldowns: Dict[str, float] = {}

# Broadcast callback registered by server.py / fastapi_app.py
_broadcast_callback: Optional[Callable[[Dict[str, Any]], Any]] = None


def set_broadcast_callback(cb: Optional[Callable[[Dict[str, Any]], Any]]) -> None:
    """Register WebSocket broadcast callback for live alert events."""
    global _broadcast_callback
    _broadcast_callback = cb


async def _broadcast_event(payload: Dict[str, Any]) -> None:
    """Send alert event to connected dashboard clients via registered callback."""
    if _broadcast_callback:
        try:
            res = _broadcast_callback(payload)
            if asyncio.iscoroutine(res):
                await res
        except Exception as e:
            logger.debug("[Alerts] Broadcast callback error: %s", e)


# ─── Alert Rule CRUD & Management ──────────────────────────────────────────────

async def list_alert_rules(server_id: Optional[str] = None, include_inactive: bool = False) -> List[Dict[str, Any]]:
    """Return all alert rules, optionally filtered by server."""
    from database import fetchall
    active_clause = "" if include_inactive else "WHERE is_active = 1"
    if server_id:
        query = f"""
            SELECT ar.*, s.hostname as server_hostname, s.display_name as server_display_name
            FROM alert_rules ar
            LEFT JOIN servers s ON ar.server_id = s.id
            {"WHERE" if include_inactive else "WHERE ar.is_active = 1 AND"} (ar.server_id = ? OR ar.server_id IS NULL)
            ORDER BY ar.created_at DESC
        """
        return await fetchall(query, (server_id,))
    
    query = f"""
        SELECT ar.*, s.hostname as server_hostname, s.display_name as server_display_name
        FROM alert_rules ar
        LEFT JOIN servers s ON ar.server_id = s.id
        {active_clause}
        ORDER BY ar.created_at DESC
    """
    return await fetchall(query)


async def create_alert_rule(
    name: str,
    metric: str,
    operator: str,
    threshold: Optional[float],
    severity: str = "warning",
    server_id: Optional[str] = None,
    notify_email: bool = False,
    notify_webhook: bool = False,
    webhook_url: Optional[str] = None,
    channel_type: str = "webhook",
    target_service: Optional[str] = None,
    cooldown_minutes: int = 15,
    created_by: Optional[int] = None,
) -> Dict[str, Any]:
    """Create a new alert rule with modern metric & channel support."""
    from database import execute

    if metric not in VALID_METRICS:
        return {"success": False, "error": f"Invalid metric. Valid: {', '.join(sorted(VALID_METRICS))}"}
    if operator not in VALID_OPERATORS:
        return {"success": False, "error": f"Invalid operator. Valid: {', '.join(sorted(VALID_OPERATORS))}"}
    if severity not in VALID_SEVERITIES:
        return {"success": False, "error": f"Invalid severity. Valid: {', '.join(sorted(VALID_SEVERITIES))}"}
    if not name or len(name) > 200:
        return {"success": False, "error": "Rule name must be between 1 and 200 characters"}

    rule_id = await execute(
        "INSERT INTO alert_rules ("
        "  name, server_id, metric, operator, threshold, severity, is_active, "
        "  notify_email, notify_webhook, webhook_url, channel_type, target_service, cooldown_minutes, created_by"
        ") VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
        (
            name, server_id, metric, operator, threshold, severity,
            1 if notify_email else 0, 1 if notify_webhook else 0, webhook_url,
            channel_type or "webhook", target_service or "", max(1, int(cooldown_minutes or 15)), created_by
        )
    )
    logger.info("[Alerts] Created rule '%s' (id=%d) for server=%s metric=%s", name, rule_id, server_id or "global", metric)
    return {"success": True, "rule_id": rule_id}


async def toggle_alert_rule(rule_id: int) -> Dict[str, Any]:
    """Toggle an alert rule enabled/disabled."""
    from database import execute, fetchone
    rule = await fetchone("SELECT id, is_active, name FROM alert_rules WHERE id = ?", (rule_id,))
    if not rule:
        return {"success": False, "error": "Alert rule not found"}
    
    new_state = 0 if rule["is_active"] == 1 else 1
    await execute("UPDATE alert_rules SET is_active = ? WHERE id = ?", (new_state, rule_id))
    logger.info("[Alerts] Toggled rule id=%d ('%s') active=%d", rule_id, rule["name"], new_state)
    return {"success": True, "is_active": new_state, "name": rule["name"]}


async def delete_alert_rule(rule_id: int) -> Dict[str, Any]:
    """Permanently delete or deactivate an alert rule."""
    from database import execute
    await execute("DELETE FROM alert_rules WHERE id = ?", (rule_id,))
    logger.info("[Alerts] Deleted rule id=%d", rule_id)
    return {"success": True}


# ─── Incident Lifecycle & Active Alerts ───────────────────────────────────────

async def get_active_alerts(server_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return currently firing or acknowledged (unresolved) alerts."""
    from database import fetchall
    base_query = """
        SELECT aa.*, ar.name as rule_name, ar.severity, ar.metric, ar.threshold, ar.operator,
               ar.target_service, s.hostname, s.display_name
        FROM active_alerts aa
        JOIN alert_rules ar ON aa.rule_id = ar.id
        LEFT JOIN servers s ON aa.server_id = s.id
        WHERE aa.resolved_at IS NULL
    """
    if server_id:
        return await fetchall(
            base_query + " AND aa.server_id = ? ORDER BY (CASE WHEN aa.acknowledged_at IS NULL THEN 0 ELSE 1 END), aa.fired_at DESC",
            (server_id,)
        )
    return await fetchall(
        base_query + " ORDER BY (CASE WHEN aa.acknowledged_at IS NULL THEN 0 ELSE 1 END), aa.fired_at DESC"
    )


async def get_all_alerts(limit: int = 100, server_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return recent alert history (both active and resolved incidents)."""
    from database import fetchall
    base_query = """
        SELECT aa.*, ar.name as rule_name, ar.severity, ar.metric, ar.threshold, ar.operator,
               s.hostname, s.display_name
        FROM active_alerts aa
        JOIN alert_rules ar ON aa.rule_id = ar.id
        LEFT JOIN servers s ON aa.server_id = s.id
    """
    if server_id:
        return await fetchall(
            base_query + " WHERE aa.server_id = ? ORDER BY aa.fired_at DESC LIMIT ?",
            (server_id, limit)
        )
    return await fetchall(base_query + " ORDER BY aa.fired_at DESC LIMIT ?", (limit,))


async def acknowledge_alert(alert_id: int, user_email: str, note: str = "") -> Dict[str, Any]:
    """Acknowledge a firing alert so team members know it is being investigated."""
    from database import execute, fetchone
    alert = await fetchone("SELECT * FROM active_alerts WHERE id = ? AND resolved_at IS NULL", (alert_id,))
    if not alert:
        return {"success": False, "error": "Active alert not found or already resolved"}

    now_iso = datetime.now(timezone.utc).isoformat()
    await execute(
        "UPDATE active_alerts SET acknowledged_at = ?, acknowledged_by = ?, acknowledged_note = ? WHERE id = ?",
        (now_iso, user_email, note or "Acknowledged via dashboard", alert_id)
    )
    logger.info("[Alerts] Alert id=%d acknowledged by %s", alert_id, user_email)

    # Broadcast real-time update
    await _broadcast_event({
        "type": "alert_acknowledged",
        "alert_id": alert_id,
        "acknowledged_at": now_iso,
        "acknowledged_by": user_email,
        "note": note,
    })
    return {"success": True, "alert_id": alert_id, "acknowledged_by": user_email}


async def resolve_alert_manual(alert_id: int, user_email: str) -> Dict[str, Any]:
    """Manually resolve a firing alert from the dashboard."""
    from database import fetchone, execute
    alert = await fetchone(
        "SELECT aa.*, ar.name as rule_name, ar.severity, ar.metric, ar.notify_webhook, ar.webhook_url, "
        "ar.notify_email, ar.channel_type "
        "FROM active_alerts aa JOIN alert_rules ar ON aa.rule_id = ar.id WHERE aa.id = ?",
        (alert_id,)
    )
    if not alert:
        return {"success": False, "error": "Alert not found"}
    if alert["resolved_at"]:
        return {"success": True, "message": "Alert was already resolved"}

    now_iso = datetime.now(timezone.utc).isoformat()
    await execute("UPDATE active_alerts SET resolved_at = ? WHERE id = ?", (now_iso, alert_id))
    logger.info("[Alerts] Alert id=%d manually resolved by %s", alert_id, user_email)

    # Broadcast real-time update
    await _broadcast_event({
        "type": "alert_resolved",
        "alert_id": alert_id,
        "resolved_at": now_iso,
        "resolved_by": user_email,
    })

    # Dispatch recovery notification
    alert_info = dict(alert)
    alert_info["resolved_at"] = now_iso
    alert_info["resolved_by"] = user_email
    alert_info["is_recovery"] = True
    asyncio.create_task(_send_notifications(alert, alert_info, is_recovery=True))

    return {"success": True, "alert_id": alert_id, "resolved_at": now_iso}


async def get_alert_stats() -> Dict[str, Any]:
    """Return aggregated incident statistics for dashboard widgets."""
    from database import fetchone
    firing_row = await fetchone(
        "SELECT COUNT(*) as count FROM active_alerts WHERE resolved_at IS NULL AND acknowledged_at IS NULL"
    )
    ack_row = await fetchone(
        "SELECT COUNT(*) as count FROM active_alerts WHERE resolved_at IS NULL AND acknowledged_at IS NOT NULL"
    )
    critical_row = await fetchone(
        "SELECT COUNT(*) as count FROM active_alerts aa "
        "JOIN alert_rules ar ON aa.rule_id = ar.id "
        "WHERE aa.resolved_at IS NULL AND ar.severity = 'critical'"
    )
    resolved_today_row = await fetchone(
        "SELECT COUNT(*) as count FROM active_alerts "
        "WHERE resolved_at >= datetime('now', '-24 hours')"
    )
    rules_row = await fetchone("SELECT COUNT(*) as count FROM alert_rules WHERE is_active = 1")

    return {
        "firing": (firing_row or {}).get("count", 0),
        "acknowledged": (ack_row or {}).get("count", 0),
        "critical": (critical_row or {}).get("count", 0),
        "resolved_24h": (resolved_today_row or {}).get("count", 0),
        "rules_active": (rules_row or {}).get("count", 0),
    }


async def _fire_alert(rule_id: int, server_id: str, details: str) -> int:
    """Insert a new firing alert record."""
    from database import execute
    return await execute(
        "INSERT INTO active_alerts (rule_id, server_id, fired_at, details) VALUES (?, ?, datetime('now'), ?)",
        (rule_id, server_id, details)
    )


async def _resolve_alert(alert_id: int) -> None:
    """Mark an alert as automatically resolved and dispatch recovery notifications."""
    from database import execute, fetchone
    alert = await fetchone(
        "SELECT aa.*, ar.name as rule_name, ar.severity, ar.metric, ar.notify_webhook, ar.webhook_url, "
        "ar.notify_email, ar.channel_type "
        "FROM active_alerts aa JOIN alert_rules ar ON aa.rule_id = ar.id WHERE aa.id = ?",
        (alert_id,)
    )
    if not alert or alert["resolved_at"]:
        return

    now_iso = datetime.now(timezone.utc).isoformat()
    await execute("UPDATE active_alerts SET resolved_at = datetime('now') WHERE id = ?", (alert_id,))
    logger.info("[Alerts] Auto-resolved alert id=%d", alert_id)

    # Broadcast resolution
    await _broadcast_event({
        "type": "alert_resolved",
        "alert_id": alert_id,
        "resolved_at": now_iso,
        "auto": True,
    })

    # Dispatch recovery notification
    alert_info = dict(alert)
    alert_info["resolved_at"] = now_iso
    alert_info["is_recovery"] = True
    asyncio.create_task(_send_notifications(alert, alert_info, is_recovery=True))


# ─── Alert Evaluation Engine ──────────────────────────────────────────────────

def _evaluate_condition(value: float, operator: str, threshold: float) -> bool:
    """Evaluate metric value against operator and threshold."""
    if operator == "gt":
        return value > threshold
    if operator == "lt":
        return value < threshold
    if operator == "eq":
        return abs(value - threshold) < 0.001
    return False


def _extract_metric_values(snapshot: Dict[str, Any]) -> Dict[str, float]:
    """Extract standard numeric metrics from a heterogeneous telemetry snapshot."""
    mem = snapshot.get("memory", {})
    disks = snapshot.get("disks", [])
    net = snapshot.get("network", {})
    sys_info = snapshot.get("sysInfo", {})

    # CPU percent
    cpu = snapshot.get("cpu_percent")
    if cpu is None:
        cpu = snapshot.get("cpu", 0)

    # Memory percent
    mem_p = snapshot.get("mem_percent")
    if mem_p is None:
        mem_p = mem.get("usagePercent", 0)

    # Disk percent
    disk_p = snapshot.get("disk_percent")
    if disk_p is None and disks:
        disk_p = disks[0].get("usagePercent", 0)
    elif disk_p is None:
        disk_p = 0.0

    # Swap percent
    swap_p = snapshot.get("swap_percent")
    if swap_p is None:
        swap_p = mem.get("swapPercent", 0)

    # Load Average
    load_avg = sys_info.get("loadAvg") or [0, 0, 0]
    load_1 = snapshot.get("load_avg_1")
    if load_1 is None:
        load_1 = load_avg[0] if load_avg else 0
    load_15 = snapshot.get("load_avg_15")
    if load_15 is None:
        load_15 = load_avg[2] if len(load_avg) > 2 else 0

    # Network in MB/s
    rx_bytes = snapshot.get("net_rx_sec") or net.get("rxSec", 0)
    tx_bytes = snapshot.get("net_tx_sec") or net.get("txSec", 0)
    rx_mb = round(float(rx_bytes) / (1024 * 1024), 2)
    tx_mb = round(float(tx_bytes) / (1024 * 1024), 2)

    return {
        "cpu_percent": float(cpu or 0),
        "mem_percent": float(mem_p or 0),
        "disk_percent": float(disk_p or 0),
        "swap_percent": float(swap_p or 0),
        "load_avg_1": float(load_1 or 0),
        "load_avg_15": float(load_15 or 0),
        "net_rx_mb": float(rx_mb or 0),
        "net_tx_mb": float(tx_mb or 0),
    }


async def evaluate_alerts_for_server(server_id: str, snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Evaluate active alert rules against a server's latest telemetry snapshot.

    Fires new alerts, resolves active ones, and delivers real-time notifications.
    """
    from database import fetchone

    rules = await list_alert_rules(server_id)
    if not rules:
        return []

    metric_map = _extract_metric_values(snapshot)
    newly_fired = []

    for rule in rules:
        metric = rule["metric"]
        if metric not in metric_map:
            # Special metric rules (e.g., agent_offline, service_down) handled by their dedicated evaluators
            continue

        current_value = metric_map[metric]
        try:
            threshold = float(rule.get("threshold") or 0)
        except (ValueError, TypeError):
            threshold = 0.0

        operator = rule["operator"]
        condition_met = _evaluate_condition(current_value, operator, threshold)

        # Check if an active alert already exists for this rule and server
        existing = await fetchone(
            "SELECT id, fired_at, acknowledged_at FROM active_alerts "
            "WHERE rule_id = ? AND server_id = ? AND resolved_at IS NULL",
            (rule["id"], server_id)
        )

        cooldown_key = f"{rule['id']}:{server_id}"
        now_ts = time.time()
        cooldown_secs = (rule.get("cooldown_minutes") or 15) * 60

        if condition_met and not existing:
            # Fire new alert
            details = json.dumps({
                "metric": metric,
                "value": round(current_value, 2),
                "threshold": threshold,
                "operator": operator,
            })
            alert_id = await _fire_alert(rule["id"], server_id, details)
            alert_info = {
                "id": alert_id,
                "alert_id": alert_id,
                "rule_id": rule["id"],
                "rule_name": rule["name"],
                "severity": rule["severity"],
                "metric": metric,
                "value": round(current_value, 2),
                "threshold": threshold,
                "operator": operator,
                "server_id": server_id,
                "fired_at": datetime.now(timezone.utc).isoformat(),
                "acknowledged_at": None,
                "is_recovery": False,
            }
            newly_fired.append(alert_info)
            _notification_cooldowns[cooldown_key] = now_ts
            logger.warning("[Alerts] FIRED: rule='%s' server=%s %s=%s %s %s",
                           rule["name"], server_id, metric, current_value, operator, threshold)

            # Broadcast to UI immediately
            await _broadcast_event({
                "type": "alert_fired",
                "alert": alert_info,
            })

            # Send notifications (Webhook, Discord, Slack, Email)
            asyncio.create_task(_send_notifications(rule, alert_info, is_recovery=False))

        elif condition_met and existing:
            # Alert is already firing; check if cooldown expired for repeat notifications
            last_notified = _notification_cooldowns.get(cooldown_key, 0)
            if now_ts - last_notified >= cooldown_secs:
                _notification_cooldowns[cooldown_key] = now_ts
                alert_info = {
                    "id": existing["id"],
                    "alert_id": existing["id"],
                    "rule_id": rule["id"],
                    "rule_name": rule["name"],
                    "severity": rule["severity"],
                    "metric": metric,
                    "value": round(current_value, 2),
                    "threshold": threshold,
                    "server_id": server_id,
                    "fired_at": existing["fired_at"],
                    "is_repeat": True,
                    "is_recovery": False,
                }
                asyncio.create_task(_send_notifications(rule, alert_info, is_recovery=False))

        elif not condition_met and existing:
            # Condition cleared — resolve alert
            await _resolve_alert(existing["id"])
            if cooldown_key in _notification_cooldowns:
                del _notification_cooldowns[cooldown_key]
            logger.info("[Alerts] RESOLVED: rule='%s' server=%s (metric %s returned to normal: %s)",
                        rule["name"], server_id, metric, current_value)

    return newly_fired


async def evaluate_agent_offline(server_id: str, hostname: str) -> None:
    """Fire agent_offline alert for a server that stopped sending heartbeats."""
    from database import fetchone
    rules = await list_alert_rules(server_id)
    offline_rules = [r for r in rules if r["metric"] == "agent_offline" and r.get("is_active", 1)]

    for rule in offline_rules:
        existing = await fetchone(
            "SELECT id FROM active_alerts WHERE rule_id = ? AND server_id = ? AND resolved_at IS NULL",
            (rule["id"], server_id)
        )
        if not existing:
            details = json.dumps({"hostname": hostname, "reason": "heartbeat_timeout", "metric": "agent_offline"})
            alert_id = await _fire_alert(rule["id"], server_id, details)
            alert_info = {
                "id": alert_id,
                "alert_id": alert_id,
                "rule_id": rule["id"],
                "rule_name": rule["name"],
                "severity": rule["severity"],
                "metric": "agent_offline",
                "value": "offline",
                "threshold": 0,
                "server_id": server_id,
                "hostname": hostname,
                "fired_at": datetime.now(timezone.utc).isoformat(),
                "is_recovery": False,
            }
            logger.warning("[Alerts] FIRED agent_offline for server %s (%s)", server_id, hostname)
            await _broadcast_event({"type": "alert_fired", "alert": alert_info})
            asyncio.create_task(_send_notifications(rule, alert_info, is_recovery=False))


async def resolve_agent_offline(server_id: str) -> None:
    """Resolve any active agent_offline alerts when a server reconnects."""
    from database import fetchall
    active = await fetchall(
        "SELECT aa.id FROM active_alerts aa JOIN alert_rules ar ON aa.rule_id = ar.id "
        "WHERE aa.server_id = ? AND ar.metric = 'agent_offline' AND aa.resolved_at IS NULL",
        (server_id,)
    )
    for alert in active:
        await _resolve_alert(alert["id"])


async def evaluate_service_down(server_id: str, service_name: str, is_active: bool) -> None:
    """Evaluate systemd service state against service_down rules."""
    from database import fetchone
    rules = await list_alert_rules(server_id)
    service_rules = [
        r for r in rules
        if r["metric"] == "service_down" and r.get("is_active", 1) and
        (not r.get("target_service") or r.get("target_service").strip().lower() == service_name.strip().lower())
    ]

    for rule in service_rules:
        existing = await fetchone(
            "SELECT id FROM active_alerts WHERE rule_id = ? AND server_id = ? AND resolved_at IS NULL",
            (rule["id"], server_id)
        )
        if not is_active and not existing:
            details = json.dumps({"service": service_name, "state": "down", "metric": "service_down"})
            alert_id = await _fire_alert(rule["id"], server_id, details)
            alert_info = {
                "id": alert_id,
                "alert_id": alert_id,
                "rule_id": rule["id"],
                "rule_name": rule["name"],
                "severity": rule["severity"],
                "metric": "service_down",
                "value": f"{service_name} (inactive)",
                "server_id": server_id,
                "fired_at": datetime.now(timezone.utc).isoformat(),
                "is_recovery": False,
            }
            logger.warning("[Alerts] FIRED service_down: %s on server %s", service_name, server_id)
            await _broadcast_event({"type": "alert_fired", "alert": alert_info})
            asyncio.create_task(_send_notifications(rule, alert_info, is_recovery=False))
        elif is_active and existing:
            await _resolve_alert(existing["id"])


# ─── Multi-Channel Notification Dispatcher ────────────────────────────────────

async def _send_notifications(rule: Dict[str, Any], alert_info: Dict[str, Any], is_recovery: bool = False) -> None:
    """Dispatch alert or recovery notifications across configured channels."""
    server_id = alert_info.get("server_id", "")
    try:
        import maintenance_manager
        if server_id and await maintenance_manager.is_server_in_maintenance(server_id):
            logger.info("[Alerts] Notification suppressed for server %s (active maintenance window).", server_id)
            return
    except Exception as e:
        logger.debug("[Alerts] Maintenance check error: %s", e)

    tasks = []
    if rule.get("notify_webhook") and rule.get("webhook_url"):
        channel_type = rule.get("channel_type") or "webhook"
        tasks.append(_send_webhook(rule["webhook_url"], alert_info, channel_type=channel_type, is_recovery=is_recovery))

    if rule.get("notify_email"):
        tasks.append(_send_email_alert(alert_info, is_recovery=is_recovery))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _send_webhook(url: str, alert_info: Dict[str, Any], channel_type: str = "webhook", is_recovery: bool = False) -> Dict[str, Any]:
    """Deliver webhook notification formatted for Discord, Slack, Telegram, or Generic Webhook."""
    try:
        import aiohttp
    except ImportError:
        logger.warning("[Alerts] aiohttp not installed — webhook delivery skipped")
        return {"success": False, "error": "aiohttp not installed"}

    severity = (alert_info.get("severity") or "warning").upper()
    server = alert_info.get("hostname") or alert_info.get("server_id") or "master-node"
    metric = alert_info.get("metric", "system")
    value = alert_info.get("value", "")
    rule_name = alert_info.get("rule_name", "PulseOps Alert")
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # Status styling
    if is_recovery:
        status_title = f"🟢 RECOVERED: {rule_name}"
        color_hex = 0x10B981  # Emerald green
        color_str = "#10b981"
        status_text = "Metric returned to nominal operational levels."
    elif severity == "CRITICAL":
        status_title = f"🚨 CRITICAL: {rule_name}"
        color_hex = 0xEF4444  # Red
        color_str = "#ef4444"
        status_text = f"Threshold breached: {metric} = {value}"
    else:
        status_title = f"⚠️ WARNING: {rule_name}"
        color_hex = 0xF59E0B  # Amber
        color_str = "#f59e0b"
        status_text = f"Warning condition: {metric} = {value}"

    # Auto-detect webhook provider if generic URL contains signatures
    url_lower = url.lower()
    if "discord.com/api/webhooks" in url_lower:
        channel_type = "discord"
    elif "hooks.slack.com" in url_lower:
        channel_type = "slack"
    elif "api.telegram.org/bot" in url_lower:
        channel_type = "telegram"

    payload: Dict[str, Any] = {}

    if channel_type == "discord":
        payload = {
            "username": "PulseOps Sentinel",
            "avatar_url": "https://raw.githubusercontent.com/google/material-design-icons/master/png/action/bolt/materialicons/48dp/2x/baseline_bolt_black_48dp.png",
            "embeds": [{
                "title": status_title,
                "description": status_text,
                "color": color_hex,
                "fields": [
                    {"name": "Server", "value": f"`{server}`", "inline": True},
                    {"name": "Metric", "value": f"`{metric}`", "inline": True},
                    {"name": "Current Value", "value": f"**{value}**", "inline": True},
                    {"name": "Status", "value": "Resolved" if is_recovery else "Firing", "inline": True},
                    {"name": "Timestamp", "value": timestamp, "inline": True},
                ],
                "footer": {"text": "PulseOps Observability & SRE Incident Center"}
            }]
        }
    elif channel_type == "slack":
        payload = {
            "text": f"{status_title} on `{server}`",
            "attachments": [{
                "color": color_str,
                "title": status_title,
                "text": status_text,
                "fields": [
                    {"title": "Server", "value": str(server), "short": True},
                    {"title": "Metric", "value": str(metric), "short": True},
                    {"title": "Value", "value": str(value), "short": True},
                    {"title": "Timestamp", "value": timestamp, "short": True},
                ],
                "footer": "PulseOps Enterprise Monitoring",
            }]
        }
    elif channel_type == "telegram":
        icon = "🟢" if is_recovery else ("🚨" if severity == "CRITICAL" else "⚠️")
        text = (
            f"{icon} *PulseOps Alert*\n"
            f"*State:* {'RESOLVED' if is_recovery else severity}\n"
            f"*Rule:* {rule_name}\n"
            f"*Server:* `{server}`\n"
            f"*Metric:* `{metric}` = `{value}`\n"
            f"*Time:* {timestamp}"
        )
        payload = {"text": text, "parse_mode": "Markdown"}
    else:
        # Standard Generic Webhook format
        payload = {
            "event": "alert_resolved" if is_recovery else "alert_fired",
            "severity": severity,
            "rule_name": rule_name,
            "server": server,
            "metric": metric,
            "value": value,
            "status": "resolved" if is_recovery else "firing",
            "timestamp": timestamp,
            "alert_info": alert_info,
        }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status in (200, 201, 204):
                    logger.info("[Alerts] Webhook successfully delivered to %s (channel=%s)", url, channel_type)
                    return {"success": True, "status": resp.status}
                else:
                    body = await resp.text()
                    logger.warning("[Alerts] Webhook %s returned status %d: %s", url, resp.status, body[:200])
                    return {"success": False, "status": resp.status, "error": body[:200]}
    except Exception as e:
        logger.error("[Alerts] Webhook delivery failed for %s: %s", url, e)
        return {"success": False, "error": str(e)}


async def _send_email_alert(alert_info: Dict[str, Any], is_recovery: bool = False) -> None:
    """Send alert or recovery notification email via SMTP."""
    try:
        from database import get_setting, fetchone
        smtp_host = await get_setting("smtp_host")
        if not smtp_host:
            return

        import aiosmtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        try:
            smtp_port = int(await get_setting("smtp_port", "587"))
        except (ValueError, TypeError):
            smtp_port = 587
        smtp_user = await get_setting("smtp_username")
        smtp_pass = await get_setting("smtp_password")
        smtp_from = await get_setting("smtp_from", "PulseOps Alerts <noreply@pulseops.local>")
        admin_email = smtp_user
        if not admin_email:
            row = await fetchone("SELECT email FROM users WHERE role = 'admin' LIMIT 1")
            if row:
                admin_email = row["email"]

        if not admin_email:
            return

        prefix = "🟢 RESOLVED" if is_recovery else f"🚨 {alert_info.get('severity', 'WARNING').upper()}"
        subject = f"[PulseOps] {prefix}: {alert_info.get('rule_name')}"

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = smtp_from
        msg["To"] = admin_email

        status_text = "The condition has cleared and returned to normal." if is_recovery else "Threshold condition violated."
        body_plain = (
            f"PulseOps Incident Alert\n\n"
            f"Status: {'RESOLVED' if is_recovery else 'FIRING'}\n"
            f"Rule: {alert_info.get('rule_name')}\n"
            f"Severity: {alert_info.get('severity', 'warning').upper()}\n"
            f"Server: {alert_info.get('server_id', 'unknown')}\n"
            f"Metric: {alert_info.get('metric', '')}\n"
            f"Current Value: {alert_info.get('value', '')}\n"
            f"Details: {status_text}\n"
            f"Time: {datetime.now(timezone.utc).isoformat()}\n"
        )
        msg.attach(MIMEText(body_plain, "plain"))

        await aiosmtplib.send(
            msg,
            hostname=smtp_host,
            port=smtp_port,
            username=smtp_user or None,
            password=smtp_pass or None,
            start_tls=(smtp_port == 587),
            use_tls=(smtp_port == 465),
            timeout=10,
        )
        logger.info("[Alerts] Email notification sent to %s for '%s'", admin_email, alert_info.get("rule_name"))
    except Exception as e:
        logger.error("[Alerts] Email alert failed: %s", e)


# ─── Interactive Testing & Verification ───────────────────────────────────────

async def test_webhook_channel(url: str, channel_type: str = "webhook") -> Dict[str, Any]:
    """Test webhook delivery with a synthetic test alert payload."""
    test_alert = {
        "id": 99999,
        "alert_id": 99999,
        "rule_name": "PulseOps Test Sentinel",
        "severity": "info",
        "metric": "cpu_percent",
        "value": 42.0,
        "threshold": 80.0,
        "server_id": "test-node",
        "hostname": "test-cluster.local",
    }
    start_t = time.time()
    result = await _send_webhook(url, test_alert, channel_type=channel_type, is_recovery=False)
    elapsed_ms = round((time.time() - start_t) * 1000, 1)
    result["latency_ms"] = elapsed_ms
    return result


async def test_alert_rule(rule_id: int) -> Dict[str, Any]:
    """Trigger a simulated fire on an existing rule to test its channels."""
    from database import fetchone
    rule = await fetchone("SELECT * FROM alert_rules WHERE id = ?", (rule_id,))
    if not rule:
        return {"success": False, "error": "Alert rule not found"}

    test_info = {
        "id": 0,
        "alert_id": 0,
        "rule_id": rule["id"],
        "rule_name": f"[TEST] {rule['name']}",
        "severity": rule["severity"],
        "metric": rule["metric"],
        "value": (rule["threshold"] or 50.0) + 5.0,
        "threshold": rule["threshold"],
        "server_id": rule.get("server_id") or "master-node",
        "hostname": "local-server",
        "is_test": True,
        "is_recovery": False,
    }

    await _send_notifications(rule, test_info, is_recovery=False)
    return {"success": True, "message": f"Test notification dispatched for rule '{rule['name']}'"}


async def send_test_email() -> Dict[str, Any]:
    """Send a test email using configured SMTP settings."""
    try:
        from database import get_setting, fetchone
        smtp_host = await get_setting("smtp_host")
        if not smtp_host:
            return {"success": False, "error": "SMTP Host is not configured in Settings"}

        import aiosmtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        try:
            smtp_port = int(await get_setting("smtp_port", "587"))
        except (ValueError, TypeError):
            smtp_port = 587
        smtp_user = await get_setting("smtp_username")
        smtp_pass = await get_setting("smtp_password")
        smtp_from = await get_setting("smtp_from", "PulseOps Alerts <noreply@pulseops.local>")

        to_email = smtp_user
        if not to_email:
            row = await fetchone("SELECT email FROM users WHERE role = 'admin' LIMIT 1")
            if row:
                to_email = row["email"]

        if not to_email:
            return {"success": False, "error": "No recipient email configured for SMTP test"}

        msg = MIMEMultipart("alternative")
        msg["Subject"] = "[PulseOps] SMTP Test Message"
        msg["From"] = smtp_from
        msg["To"] = to_email

        body = (
            "This is a test email sent from PulseOps Enterprise to verify that your "
            "SMTP notification settings are properly configured.\n\n"
            f"Timestamp: {datetime.now(timezone.utc).isoformat()}\n"
        )
        msg.attach(MIMEText(body, "plain"))

        await aiosmtplib.send(
            msg,
            hostname=smtp_host,
            port=smtp_port,
            username=smtp_user or None,
            password=smtp_pass or None,
            start_tls=(smtp_port == 587),
            use_tls=(smtp_port == 465),
            timeout=10,
        )
        return {"success": True, "message": f"Test email sent to {to_email}"}
    except ImportError:
        return {"success": False, "error": "aiosmtplib is not installed on server"}
    except Exception as e:
        logger.error("[Alerts] SMTP test failed: %s", e)
        return {"success": False, "error": str(e)}
