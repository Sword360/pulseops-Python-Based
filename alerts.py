"""
alerts.py — PulseOps Enterprise Alerting & Notification Engine.

Evaluates alert rules against live telemetry snapshots, tracks firing/resolved
states, delivers notifications via email and webhook, and exposes CRUD APIs
for managing alert rule configurations.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("pulseops.alerts")

VALID_METRICS = {"cpu_percent", "mem_percent", "disk_percent", "agent_offline", "service_down"}
VALID_OPERATORS = {"gt", "lt", "eq"}
VALID_SEVERITIES = {"critical", "warning", "info"}


# ─── Alert Rule CRUD ──────────────────────────────────────────────────────────

async def list_alert_rules(server_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return all alert rules, optionally filtered by server.

    Args:
        server_id: If provided, returns rules for this server plus global rules.

    Returns:
        List of alert rule dicts.
    """
    from database import fetchall
    if server_id:
        return await fetchall(
            "SELECT * FROM alert_rules WHERE (server_id = ? OR server_id IS NULL) AND is_active = 1 ORDER BY created_at DESC",
            (server_id,)
        )
    return await fetchall("SELECT * FROM alert_rules WHERE is_active = 1 ORDER BY created_at DESC")


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
    created_by: Optional[int] = None,
) -> Dict[str, Any]:
    """Create a new alert rule.

    Args:
        name: Human-readable rule name.
        metric: Metric to evaluate (cpu_percent, mem_percent, etc.).
        operator: Comparison operator (gt, lt, eq).
        threshold: Numeric threshold value.
        severity: Alert severity level.
        server_id: Specific server UUID or None for global rule.
        notify_email: Send email on alert fire.
        notify_webhook: POST to webhook URL on alert fire.
        webhook_url: Target webhook URL.
        created_by: User ID creating this rule.

    Returns:
        Dict with 'success' bool and 'rule_id' or 'error'.
    """
    from database import execute

    if metric not in VALID_METRICS:
        return {"success": False, "error": f"Invalid metric. Valid: {', '.join(VALID_METRICS)}"}
    if operator not in VALID_OPERATORS:
        return {"success": False, "error": f"Invalid operator. Valid: {', '.join(VALID_OPERATORS)}"}
    if severity not in VALID_SEVERITIES:
        return {"success": False, "error": f"Invalid severity. Valid: {', '.join(VALID_SEVERITIES)}"}
    if not name or len(name) > 200:
        return {"success": False, "error": "Rule name must be 1–200 characters"}

    rule_id = await execute(
        "INSERT INTO alert_rules (name, server_id, metric, operator, threshold, severity, "
        "notify_email, notify_webhook, webhook_url, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (name, server_id, metric, operator, threshold, severity,
         1 if notify_email else 0, 1 if notify_webhook else 0, webhook_url, created_by)
    )
    logger.info("[Alerts] Created rule '%s' (id=%d) for server=%s", name, rule_id, server_id or "global")
    return {"success": True, "rule_id": rule_id}


async def delete_alert_rule(rule_id: int) -> Dict[str, Any]:
    """Deactivate an alert rule (soft delete).

    Args:
        rule_id: Alert rule database ID.

    Returns:
        Dict with 'success' bool.
    """
    from database import execute
    await execute("UPDATE alert_rules SET is_active = 0 WHERE id = ?", (rule_id,))
    return {"success": True}


# ─── Active Alert Management ──────────────────────────────────────────────────

async def get_active_alerts(server_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return currently firing (unresolved) alerts.

    Args:
        server_id: Optional filter by server.

    Returns:
        List of active alert dicts.
    """
    from database import fetchall
    if server_id:
        return await fetchall(
            "SELECT aa.*, ar.name as rule_name, ar.severity, ar.metric "
            "FROM active_alerts aa JOIN alert_rules ar ON aa.rule_id = ar.id "
            "WHERE aa.server_id = ? AND aa.resolved_at IS NULL ORDER BY aa.fired_at DESC",
            (server_id,)
        )
    return await fetchall(
        "SELECT aa.*, ar.name as rule_name, ar.severity, ar.metric "
        "FROM active_alerts aa JOIN alert_rules ar ON aa.rule_id = ar.id "
        "WHERE aa.resolved_at IS NULL ORDER BY aa.fired_at DESC"
    )


async def get_all_alerts(limit: int = 100) -> List[Dict[str, Any]]:
    """Return recent alerts (both active and resolved).

    Args:
        limit: Maximum number to return.

    Returns:
        List of alert dicts.
    """
    from database import fetchall
    return await fetchall(
        "SELECT aa.*, ar.name as rule_name, ar.severity, ar.metric, s.hostname "
        "FROM active_alerts aa "
        "JOIN alert_rules ar ON aa.rule_id = ar.id "
        "LEFT JOIN servers s ON aa.server_id = s.id "
        "ORDER BY aa.fired_at DESC LIMIT ?",
        (limit,)
    )


async def _fire_alert(rule_id: int, server_id: str, details: str) -> int:
    """Insert a new firing alert record.

    Args:
        rule_id: Alert rule ID.
        server_id: Server where alert fired.
        details: JSON details string.

    Returns:
        New alert record ID.
    """
    from database import execute
    return await execute(
        "INSERT INTO active_alerts (rule_id, server_id, fired_at, details) VALUES (?, ?, datetime('now'), ?)",
        (rule_id, server_id, details)
    )


async def _resolve_alert(alert_id: int) -> None:
    """Mark an alert as resolved.

    Args:
        alert_id: Active alert record ID.
    """
    from database import execute
    await execute(
        "UPDATE active_alerts SET resolved_at = datetime('now') WHERE id = ?", (alert_id,)
    )


# ─── Alert Evaluation Engine ──────────────────────────────────────────────────

def _evaluate_condition(value: float, operator: str, threshold: float) -> bool:
    """Evaluate a single alert condition.

    Args:
        value: Current metric value.
        operator: Comparison operator string.
        threshold: Numeric threshold to compare against.

    Returns:
        True if the condition is met (alert should fire).
    """
    if operator == "gt":
        return value > threshold
    if operator == "lt":
        return value < threshold
    if operator == "eq":
        return abs(value - threshold) < 0.001
    return False


async def evaluate_alerts_for_server(server_id: str, snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Evaluate all active rules against a server's latest telemetry snapshot.

    Fires new alerts and resolves existing ones as appropriate.

    Args:
        server_id: Server UUID.
        snapshot: Telemetry snapshot dict with metric values.

    Returns:
        List of newly fired alert dicts.
    """
    from database import fetchall, fetchone, execute

    rules = await list_alert_rules(server_id)
    newly_fired = []

    metric_map = {
        "cpu_percent": snapshot.get("cpu_percent", 0),
        "mem_percent": snapshot.get("mem_percent", 0),
        "disk_percent": snapshot.get("disk_percent", 0),
    }

    for rule in rules:
        metric = rule["metric"]
        if metric not in metric_map:
            continue  # agent_offline / service_down handled separately

        current_value = metric_map[metric]
        threshold = rule.get("threshold") or 0
        operator = rule["operator"]
        condition_met = _evaluate_condition(current_value, operator, threshold)

        # Check if this rule is already firing for this server
        existing = await fetchone(
            "SELECT id FROM active_alerts WHERE rule_id = ? AND server_id = ? AND resolved_at IS NULL",
            (rule["id"], server_id)
        )

        if condition_met and not existing:
            # Fire new alert
            details = json.dumps({
                "metric": metric,
                "value": current_value,
                "threshold": threshold,
                "operator": operator,
            })
            alert_id = await _fire_alert(rule["id"], server_id, details)
            alert_info = {
                "alert_id": alert_id,
                "rule_name": rule["name"],
                "severity": rule["severity"],
                "metric": metric,
                "value": current_value,
                "threshold": threshold,
                "server_id": server_id,
            }
            newly_fired.append(alert_info)
            logger.warning("[Alerts] FIRED: rule='%s' server=%s %s=%s %s %s",
                           rule["name"], server_id, metric, current_value, operator, threshold)

            # Send notifications
            asyncio.create_task(_send_notifications(rule, alert_info))

        elif not condition_met and existing:
            # Resolve
            await _resolve_alert(existing["id"])
            logger.info("[Alerts] RESOLVED: rule='%s' server=%s", rule["name"], server_id)

    return newly_fired


async def evaluate_agent_offline(server_id: str, hostname: str) -> None:
    """Fire agent_offline alert for a server that has stopped reporting.

    Args:
        server_id: Server UUID.
        hostname: Server hostname for details.
    """
    from database import fetchone, execute
    # Find global or server-specific agent_offline rules
    rules = await list_alert_rules(server_id)
    offline_rules = [r for r in rules if r["metric"] == "agent_offline"]

    for rule in offline_rules:
        existing = await fetchone(
            "SELECT id FROM active_alerts WHERE rule_id = ? AND server_id = ? AND resolved_at IS NULL",
            (rule["id"], server_id)
        )
        if not existing:
            details = json.dumps({"hostname": hostname, "reason": "heartbeat_timeout"})
            await _fire_alert(rule["id"], server_id, details)
            logger.warning("[Alerts] FIRED agent_offline for server %s (%s)", server_id, hostname)


async def resolve_agent_offline(server_id: str) -> None:
    """Resolve any agent_offline alerts when a server comes back online.

    Args:
        server_id: Server UUID.
    """
    from database import fetchall, execute
    active = await fetchall(
        "SELECT aa.id FROM active_alerts aa JOIN alert_rules ar ON aa.rule_id = ar.id "
        "WHERE aa.server_id = ? AND ar.metric = 'agent_offline' AND aa.resolved_at IS NULL",
        (server_id,)
    )
    for alert in active:
        await _resolve_alert(alert["id"])


# ─── Notification Delivery ────────────────────────────────────────────────────

async def _send_notifications(rule: Dict[str, Any], alert_info: Dict[str, Any]) -> None:
    """Dispatch alert notifications (email and/or webhook).

    Args:
        rule: Alert rule dict (contains notification config).
        alert_info: Alert details to include in the notification.
    """
    if rule.get("notify_webhook") and rule.get("webhook_url"):
        await _send_webhook(rule["webhook_url"], alert_info)
    if rule.get("notify_email"):
        await _send_email_alert(alert_info)


async def _send_webhook(url: str, alert_info: Dict[str, Any]) -> None:
    """POST alert payload to a webhook URL.

    Compatible with Slack, Discord, Teams incoming webhooks.

    Args:
        url: Target webhook URL.
        alert_info: Alert data to serialize as JSON body.
    """
    try:
        import aiohttp
        payload = {
            "text": f"🚨 PulseOps Alert: [{alert_info['severity'].upper()}] {alert_info['rule_name']}",
            "attachments": [{
                "color": "#ef4444" if alert_info["severity"] == "critical" else "#f59e0b",
                "fields": [
                    {"title": "Server", "value": alert_info.get("server_id", "unknown"), "short": True},
                    {"title": "Metric", "value": alert_info.get("metric", ""), "short": True},
                    {"title": "Value", "value": str(alert_info.get("value", "")), "short": True},
                    {"title": "Threshold", "value": str(alert_info.get("threshold", "")), "short": True},
                ]
            }]
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status not in (200, 204):
                    logger.warning("[Alerts] Webhook returned %d for %s", resp.status, url)
    except ImportError:
        logger.debug("[Alerts] aiohttp not available — webhook skipped")
    except Exception as e:
        logger.error("[Alerts] Webhook delivery failed: %s", e)


async def _send_email_alert(alert_info: Dict[str, Any]) -> None:
    """Send an alert notification email via SMTP.

    Args:
        alert_info: Alert data to include in the email body.
    """
    try:
        from database import get_setting
        smtp_host = await get_setting("smtp_host")
        if not smtp_host:
            return

        import aiosmtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        smtp_port = int(await get_setting("smtp_port", "587"))
        smtp_user = await get_setting("smtp_username")
        smtp_pass = await get_setting("smtp_password")
        smtp_from = await get_setting("smtp_from", "PulseOps Alerts <noreply@pulseops.local>")
        admin_email = smtp_user  # Send to the configured SMTP user as fallback

        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"[PulseOps] {alert_info['severity'].upper()}: {alert_info['rule_name']}"
        msg["From"] = smtp_from
        msg["To"] = admin_email

        body = (
            f"PulseOps Alert Notification\n\n"
            f"Rule: {alert_info['rule_name']}\n"
            f"Severity: {alert_info['severity'].upper()}\n"
            f"Server: {alert_info.get('server_id', 'unknown')}\n"
            f"Metric: {alert_info.get('metric', '')}\n"
            f"Value: {alert_info.get('value', '')}\n"
            f"Threshold: {alert_info.get('threshold', '')}\n"
            f"Time: {datetime.now(timezone.utc).isoformat()}\n"
        )
        msg.attach(MIMEText(body, "plain"))

        await aiosmtplib.send(
            msg,
            hostname=smtp_host,
            port=smtp_port,
            username=smtp_user or None,
            password=smtp_pass or None,
            start_tls=True,
        )
        logger.info("[Alerts] Email alert sent for rule '%s'", alert_info["rule_name"])
    except ImportError:
        logger.debug("[Alerts] aiosmtplib not available — email alert skipped")
    except Exception as e:
        logger.error("[Alerts] Email delivery failed: %s", e)
