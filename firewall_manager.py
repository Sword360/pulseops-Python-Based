"""
firewall_manager.py — PulseOps Enterprise Firewall & Network Security Rules Manager.

Provides cross-platform Linux firewall inspection, rule management, and state manipulation.
Supports:
  - firewalld (RHEL, AlmaLinux, Rocky, CentOS, Fedora) via `firewall-cmd`
  - UFW (Ubuntu, Debian) via `ufw`
  - iptables / nftables fallback
  - High-fidelity in-memory simulation for non-root / containerized demo environments
"""

import os
import re
import shutil
import asyncio
import subprocess
import logging
from typing import Dict, Any, List, Optional

logger = logging.getLogger("pulseops.firewall")

# Well-known port mappings to recognize common server applications
WELL_KNOWN_PORTS = {
    21: "FTP",
    22: "SSH",
    25: "SMTP",
    53: "DNS",
    67: "DHCP",
    68: "DHCP Client",
    69: "TFTP",
    80: "HTTP",
    110: "POP3",
    111: "RPCBind",
    123: "NTP",
    143: "IMAP",
    161: "SNMP",
    389: "LDAP",
    443: "HTTPS",
    465: "SMTPS",
    587: "Submission",
    636: "LDAPS",
    993: "IMAPS",
    995: "POP3S",
    2049: "NFS",
    3306: "MySQL / MariaDB",
    3500: "PulseOps Master",
    3501: "PulseOps Agent",
    5432: "PostgreSQL",
    5900: "VNC Remote Desktop",
    6379: "Redis",
    8000: "HTTP-Dev",
    8080: "HTTP-Alt / Tomcat",
    8443: "HTTPS-Alt",
    9090: "Cockpit / Prometheus",
    9100: "Node Exporter",
    27017: "MongoDB"
}

# In-memory mock rules for simulated environments
_SIMULATED_ACTIVE = True
_SIMULATED_RULES = [
    {
        "id": "sim-rule-1",
        "type": "port",
        "service": "SSH",
        "direction": "inbound",
        "protocol": "TCP",
        "port": "22",
        "source": "0.0.0.0/0",
        "action": "ALLOW",
        "description": "Standard SSH Administration",
        "permanent": True,
        "raw": "22/tcp"
    },
    {
        "id": "sim-rule-2",
        "type": "port",
        "service": "HTTP",
        "direction": "inbound",
        "protocol": "TCP",
        "port": "80",
        "source": "0.0.0.0/0",
        "action": "ALLOW",
        "description": "Public Web Traffic",
        "permanent": True,
        "raw": "80/tcp"
    },
    {
        "id": "sim-rule-3",
        "type": "port",
        "service": "HTTPS",
        "direction": "inbound",
        "protocol": "TCP",
        "port": "443",
        "source": "0.0.0.0/0",
        "action": "ALLOW",
        "description": "Secure Public Web Traffic",
        "permanent": True,
        "raw": "443/tcp"
    },
    {
        "id": "sim-rule-4",
        "type": "port",
        "service": "PulseOps Master",
        "direction": "inbound",
        "protocol": "TCP",
        "port": "3500",
        "source": "0.0.0.0/0",
        "action": "ALLOW",
        "description": "PulseOps Enterprise Master UI & Telemetry",
        "permanent": True,
        "raw": "3500/tcp"
    },
    {
        "id": "sim-rule-5",
        "type": "port",
        "service": "MySQL / MariaDB",
        "direction": "inbound",
        "protocol": "TCP",
        "port": "3306",
        "source": "192.168.100.0/24",
        "action": "ALLOW",
        "description": "Internal Database Subnet Only",
        "permanent": True,
        "raw": "3306/tcp"
    },
    {
        "id": "sim-rule-6",
        "type": "port",
        "service": "Redis",
        "direction": "inbound",
        "protocol": "TCP",
        "port": "6379",
        "source": "0.0.0.0/0",
        "action": "DENY",
        "description": "Block Public Redis Exposure",
        "permanent": True,
        "raw": "6379/tcp"
    }
]


def detect_firewall_backend() -> str:
    """Detect available firewall utility and whether it is actively running."""
    # Check firewalld first
    if shutil.which("firewall-cmd"):
        try:
            res = subprocess.run(["firewall-cmd", "--state"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3)
            if res.returncode == 0 and "running" in res.stdout.lower():
                return "firewalld"
        except Exception:
            pass

    # Check UFW
    if shutil.which("ufw"):
        try:
            res = subprocess.run(["ufw", "status"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3)
            if res.returncode == 0 and "status: active" in res.stdout.lower():
                return "ufw"
        except Exception:
            pass

    # Check iptables
    if shutil.which("iptables"):
        try:
            res = subprocess.run(["iptables", "-L", "INPUT", "-n"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3)
            if res.returncode == 0:
                return "iptables"
        except Exception:
            pass

    return "simulated"


# ─── Firewalld Implementation ────────────────────────────────────────────────

def _parse_firewalld() -> Dict[str, Any]:
    """Parse firewalld active zones, services, ports, and rich rules."""
    rules: List[Dict[str, Any]] = []
    zone = "public"
    default_policy = "DROP"

    try:
        # Get active zone
        z_res = subprocess.run(["firewall-cmd", "--get-active-zones"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3)
        if z_res.returncode == 0 and z_res.stdout.strip():
            first_line = z_res.stdout.strip().splitlines()[0]
            if first_line and not first_line.startswith(" "):
                zone = first_line.strip()
    except Exception:
        pass

    try:
        # List all for active zone
        list_res = subprocess.run(["firewall-cmd", f"--zone={zone}", "--list-all"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=4)
        if list_res.returncode != 0:
            return {"active": False, "backend": "firewalld", "zone": zone, "default_policy": "UNKNOWN", "rules": []}

        output = list_res.stdout
        # Parse fields
        target_m = re.search(r"^\s*target:\s*(\S+)", output, re.MULTILINE)
        if target_m:
            target_val = target_m.group(1).lower()
            default_policy = "ACCEPT" if target_val == "accept" else ("DROP" if target_val in ("drop", "default") else target_val.upper())

        # 1. Parse Ports: e.g. "ports: 8000/tcp 3500/tcp 22/tcp"
        ports_m = re.search(r"^\s*ports:\s*(.*)$", output, re.MULTILINE)
        if ports_m:
            ports_raw = ports_m.group(1).strip().split()
            for p_item in ports_raw:
                if "/" in p_item:
                    p_num, p_proto = p_item.split("/", 1)
                else:
                    p_num, p_proto = p_item, "tcp"
                port_int = int(p_num) if p_num.isdigit() else 0
                svc_name = WELL_KNOWN_PORTS.get(port_int, "")
                rules.append({
                    "id": f"port-{p_num}-{p_proto.lower()}",
                    "type": "port",
                    "service": svc_name or f"Port {p_num}",
                    "direction": "inbound",
                    "protocol": p_proto.upper(),
                    "port": p_num,
                    "source": "0.0.0.0/0",
                    "action": "ALLOW",
                    "description": f"Allowed port {p_item}",
                    "permanent": True,
                    "raw": p_item
                })

        # 2. Parse Services: e.g. "services: cockpit dhcp http https ssh"
        services_m = re.search(r"^\s*services:\s*(.*)$", output, re.MULTILINE)
        if services_m:
            services_raw = services_m.group(1).strip().split()
            for svc in services_raw:
                if not svc:
                    continue
                # Map well known service names to typical ports
                svc_port = ""
                svc_proto = "TCP"
                if svc == "ssh":
                    svc_port = "22"
                elif svc in ("http", "apache", "nginx"):
                    svc_port = "80"
                elif svc == "https":
                    svc_port = "443"
                elif svc == "cockpit":
                    svc_port = "9090"
                elif svc in ("dhcp", "dhcpv6-client"):
                    svc_port = "67/68"
                    svc_proto = "UDP"
                elif svc == "dns":
                    svc_port = "53"
                elif svc == "nfs":
                    svc_port = "2049"
                elif svc == "rpc-bind":
                    svc_port = "111"

                rules.append({
                    "id": f"svc-{svc}",
                    "type": "service",
                    "service": svc.upper(),
                    "direction": "inbound",
                    "protocol": svc_proto,
                    "port": svc_port or "service",
                    "source": "0.0.0.0/0",
                    "action": "ALLOW",
                    "description": f"Firewalld System Service: {svc}",
                    "permanent": True,
                    "raw": svc
                })

        # 3. Parse Rich Rules: e.g. rule family="ipv4" source address="1.2.3.4" port port="3306" protocol="tcp" accept
        rich_lines = []
        in_rich = False
        for line in output.splitlines():
            if "rich rules:" in line:
                in_rich = True
                first_part = line.split("rich rules:", 1)[1].strip()
                if first_part:
                    rich_lines.append(first_part)
                continue
            if in_rich:
                if line.startswith("  ") and not line.startswith("    "):
                    # New top-level section
                    in_rich = False
                    continue
                cleaned_line = line.strip()
                if cleaned_line:
                    rich_lines.append(cleaned_line)

        for idx, r_str in enumerate(rich_lines):
            act = "ALLOW"
            if "drop" in r_str.lower():
                act = "DENY"
            elif "reject" in r_str.lower():
                act = "REJECT"

            src_m = re.search(r'source address="([^"]+)"', r_str)
            src_addr = src_m.group(1) if src_m else "0.0.0.0/0"

            port_m = re.search(r'port port="([^"]+)"', r_str)
            proto_m = re.search(r'protocol="([^"]+)"', r_str)

            port_val = port_m.group(1) if port_m else "any"
            proto_val = (proto_m.group(1) if proto_m else "TCP").upper()

            rules.append({
                "id": f"rich-{idx+1}",
                "type": "rich",
                "service": WELL_KNOWN_PORTS.get(int(port_val), "") if port_val.isdigit() else "Custom",
                "direction": "inbound",
                "protocol": proto_val,
                "port": port_val,
                "source": src_addr,
                "action": act,
                "description": r_str,
                "permanent": True,
                "raw": r_str
            })

    except Exception as e:
        logger.error(f"Failed to parse firewalld rules: {e}")

    return {
        "success": True,
        "active": True,
        "backend": "firewalld",
        "zone": zone,
        "default_policy": default_policy,
        "rules_count": len(rules),
        "rules": rules
    }


def _add_firewalld_rule(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Add a new rule to firewalld permanently and reload."""
    port = str(spec.get("port", "")).strip()
    proto = str(spec.get("protocol", "tcp")).strip().lower()
    action = str(spec.get("action", "ALLOW")).strip().upper()
    source = str(spec.get("source", "")).strip()
    zone = spec.get("zone", "public")

    if not port and not spec.get("service"):
        return {"success": False, "error": "Port or service must be specified"}

    # Validation
    if port and port != "any":
        # Can be single port or range (e.g. 8000-8080)
        if "-" in port:
            parts = port.split("-")
            if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
                return {"success": False, "error": "Invalid port range"}
        elif not port.isdigit() or not (1 <= int(port) <= 65535):
            return {"success": False, "error": "Port must be between 1 and 65535"}

    if action not in ("ALLOW", "DENY", "REJECT"):
        return {"success": False, "error": "Action must be ALLOW, DENY, or REJECT"}

    try:
        # If simple public ALLOW without source restrictions:
        if action == "ALLOW" and (not source or source in ("0.0.0.0/0", "any", "all")):
            cmd = ["firewall-cmd", "--permanent", f"--zone={zone}", f"--add-port={port}/{proto}"]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
            if res.returncode != 0:
                return {"success": False, "error": res.stderr.strip() or "Failed to add port to firewalld"}
        else:
            # Rich rule
            act_word = "accept" if action == "ALLOW" else ("drop" if action == "DENY" else "reject")
            rule_parts = ['rule family="ipv4"']
            if source and source not in ("0.0.0.0/0", "any", "all"):
                rule_parts.append(f'source address="{source}"')
            if port and port != "any":
                rule_parts.append(f'port port="{port}" protocol="{proto}"')
            rule_parts.append(act_word)
            rich_rule = " ".join(rule_parts)

            cmd = ["firewall-cmd", "--permanent", f"--zone={zone}", f"--add-rich-rule={rich_rule}"]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
            if res.returncode != 0:
                return {"success": False, "error": res.stderr.strip() or "Failed to add rich rule to firewalld"}

        # Reload firewalld to apply changes
        reload_res = subprocess.run(["firewall-cmd", "--reload"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        if reload_res.returncode != 0:
            return {"success": False, "error": "Rule added but firewalld reload failed: " + reload_res.stderr.strip()}

        return {"success": True, "message": f"Firewall rule for port {port}/{proto} ({action}) applied successfully."}
    except Exception as e:
        logger.error(f"Error executing firewalld add rule: {e}")
        return {"success": False, "error": str(e)}


def _delete_firewalld_rule(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Delete a rule from firewalld permanently and reload."""
    rule_type = spec.get("type", "port")
    port = str(spec.get("port", "")).strip()
    proto = str(spec.get("protocol", "tcp")).strip().lower()
    raw = spec.get("raw", "")
    zone = spec.get("zone", "public")

    try:
        if rule_type == "service":
            svc = raw or spec.get("service", "").lower()
            cmd = ["firewall-cmd", "--permanent", f"--zone={zone}", f"--remove-service={svc}"]
        elif rule_type == "rich":
            cmd = ["firewall-cmd", "--permanent", f"--zone={zone}", f"--remove-rich-rule={raw}"]
        else:
            # Standard port
            port_spec = raw if "/" in raw else f"{port}/{proto}"
            cmd = ["firewall-cmd", "--permanent", f"--zone={zone}", f"--remove-port={port_spec}"]

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        if res.returncode != 0:
            return {"success": False, "error": res.stderr.strip() or "Failed to remove firewalld rule"}

        # Reload
        subprocess.run(["firewall-cmd", "--reload"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        return {"success": True, "message": "Firewall rule removed successfully."}
    except Exception as e:
        logger.error(f"Error deleting firewalld rule: {e}")
        return {"success": False, "error": str(e)}


# ─── UFW Implementation ──────────────────────────────────────────────────────

def _parse_ufw() -> Dict[str, Any]:
    """Parse UFW status numbered output."""
    rules: List[Dict[str, Any]] = []
    try:
        res = subprocess.run(["ufw", "status", "numbered"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        if res.returncode != 0:
            return {"success": True, "active": False, "backend": "ufw", "default_policy": "DROP", "rules": []}

        output = res.stdout
        lines = output.splitlines()
        active = any("status: active" in l.lower() for l in lines)

        # Lines format:
        # [ 1] 22/tcp                     ALLOW IN    Anywhere
        # [ 2] 80/tcp                     ALLOW IN    Anywhere
        # [ 3] 3306                       DENY IN     192.168.1.50
        rule_pattern = re.compile(r"^\[\s*(\d+)\]\s+(\S+)\s+(ALLOW|DENY|REJECT)\s+(IN|OUT)?\s+(.*)$", re.IGNORECASE)

        for line in lines:
            m = rule_pattern.match(line.strip())
            if m:
                num = m.group(1)
                to_port_raw = m.group(2)
                action = m.group(3).upper()
                direction = "outbound" if m.group(4) and m.group(4).upper() == "OUT" else "inbound"
                from_source = m.group(5).strip()

                proto = "TCP"
                port = to_port_raw
                if "/" in to_port_raw:
                    port, p = to_port_raw.split("/", 1)
                    proto = p.upper()

                port_int = int(port) if port.isdigit() else 0
                svc = WELL_KNOWN_PORTS.get(port_int, "")

                rules.append({
                    "id": f"ufw-{num}",
                    "index": int(num),
                    "type": "port",
                    "service": svc or f"Port {port}",
                    "direction": direction,
                    "protocol": proto,
                    "port": port,
                    "source": "0.0.0.0/0" if "anywhere" in from_source.lower() else from_source,
                    "action": action,
                    "description": f"UFW Rule #{num}: {to_port_raw} {action} from {from_source}",
                    "permanent": True,
                    "raw": line.strip()
                })

        return {
            "success": True,
            "active": active,
            "backend": "ufw",
            "zone": "default",
            "default_policy": "DROP",
            "rules_count": len(rules),
            "rules": rules
        }
    except Exception as e:
        logger.error(f"UFW parse error: {e}")
        return {"success": False, "active": False, "backend": "ufw", "error": str(e), "rules": []}


def _add_ufw_rule(spec: Dict[str, Any]) -> Dict[str, Any]:
    port = str(spec.get("port", "")).strip()
    proto = str(spec.get("protocol", "tcp")).strip().lower()
    action = str(spec.get("action", "ALLOW")).strip().lower()
    source = str(spec.get("source", "")).strip()

    cmd = ["ufw"]
    if action == "allow":
        cmd.append("allow")
    elif action == "deny":
        cmd.append("deny")
    else:
        cmd.append("reject")

    if source and source not in ("0.0.0.0/0", "any", "all"):
        cmd.extend(["from", source, "to", "any", "port", port, "proto", proto])
    else:
        cmd.append(f"{port}/{proto}")

    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        if res.returncode == 0:
            return {"success": True, "message": f"UFW rule added: {' '.join(cmd[1:])}"}
        return {"success": False, "error": res.stderr.strip() or res.stdout.strip()}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _delete_ufw_rule(spec: Dict[str, Any]) -> Dict[str, Any]:
    index = spec.get("index")
    try:
        if index is not None:
            cmd = ["ufw", "--force", "delete", str(index)]
        else:
            port = spec.get("port", "")
            proto = spec.get("protocol", "tcp").lower()
            cmd = ["ufw", "delete", "allow", f"{port}/{proto}"]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        if res.returncode == 0:
            return {"success": True, "message": "UFW rule deleted."}
        return {"success": False, "error": res.stderr.strip() or res.stdout.strip()}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ─── Public Sync APIs ────────────────────────────────────────────────────────

def get_firewall_status_sync() -> Dict[str, Any]:
    """Inspect the firewall status and return all configured rules."""
    backend = detect_firewall_backend()

    if backend == "firewalld":
        return _parse_firewalld()
    elif backend == "ufw":
        return _parse_ufw()
    else:
        # Simulated fallback
        return {
            "success": True,
            "active": _SIMULATED_ACTIVE,
            "backend": "simulated",
            "zone": "public",
            "default_policy": "DROP",
            "rules_count": len(_SIMULATED_RULES),
            "rules": list(_SIMULATED_RULES),
            "simulated": True
        }


def add_firewall_rule_sync(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Add a new firewall rule."""
    backend = detect_firewall_backend()

    if backend == "firewalld":
        return _add_firewalld_rule(spec)
    elif backend == "ufw":
        return _add_ufw_rule(spec)
    else:
        # Simulated mode
        port = str(spec.get("port", "80"))
        proto = str(spec.get("protocol", "TCP")).upper()
        action = str(spec.get("action", "ALLOW")).upper()
        source = str(spec.get("source", "0.0.0.0/0")) or "0.0.0.0/0"
        desc = spec.get("description") or f"Custom rule for port {port}"

        new_rule = {
            "id": f"sim-rule-{len(_SIMULATED_RULES) + 1}",
            "type": "port",
            "service": WELL_KNOWN_PORTS.get(int(port) if port.isdigit() else 0, "Custom"),
            "direction": "inbound",
            "protocol": proto,
            "port": port,
            "source": source,
            "action": action,
            "description": desc,
            "permanent": True,
            "raw": f"{port}/{proto.lower()}"
        }
        _SIMULATED_RULES.append(new_rule)
        return {"success": True, "message": f"Simulated rule for port {port}/{proto} added successfully."}


def delete_firewall_rule_sync(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Delete an existing firewall rule."""
    backend = detect_firewall_backend()

    if backend == "firewalld":
        return _delete_firewalld_rule(spec)
    elif backend == "ufw":
        return _delete_ufw_rule(spec)
    else:
        # Simulated mode
        global _SIMULATED_RULES
        rule_id = spec.get("id")
        port = str(spec.get("port", ""))
        before_len = len(_SIMULATED_RULES)
        _SIMULATED_RULES = [r for r in _SIMULATED_RULES if r.get("id") != rule_id and r.get("port") != port]
        return {"success": True, "message": f"Simulated rule deleted (removed {before_len - len(_SIMULATED_RULES)} rules)."}


def reload_firewall_sync() -> Dict[str, Any]:
    """Reload firewall ruleset."""
    backend = detect_firewall_backend()

    if backend == "firewalld":
        try:
            res = subprocess.run(["firewall-cmd", "--reload"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
            if res.returncode == 0:
                return {"success": True, "message": "Firewalld reloaded successfully"}
            return {"success": False, "error": res.stderr.strip() or "Reload failed"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    elif backend == "ufw":
        try:
            res = subprocess.run(["ufw", "reload"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
            if res.returncode == 0:
                return {"success": True, "message": "UFW reloaded successfully"}
            return {"success": False, "error": res.stderr.strip() or "Reload failed"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    else:
        return {"success": True, "message": "Simulated firewall reloaded successfully"}


# ─── Public Async APIs ───────────────────────────────────────────────────────

async def get_firewall_status() -> Dict[str, Any]:
    """Async wrapper to inspect firewall rules."""
    return await asyncio.to_thread(get_firewall_status_sync)


async def add_firewall_rule(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Async wrapper to add a firewall rule."""
    return await asyncio.to_thread(add_firewall_rule_sync, spec)


async def delete_firewall_rule(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Async wrapper to delete a firewall rule."""
    return await asyncio.to_thread(delete_firewall_rule_sync, spec)


async def reload_firewall() -> Dict[str, Any]:
    """Async wrapper to reload firewall."""
    return await asyncio.to_thread(reload_firewall_sync)
