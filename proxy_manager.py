"""
proxy_manager.py — PulseOps Enterprise Reverse Proxy Manager (Nginx / Caddy / Apache).

Provides:
1. Proxy daemon discovery & real-time operational status (Nginx, Caddy, Apache).
2. Virtual host / server block discovery & inspection across configuration trees.
3. Safe proxy host provisioning with automated syntax validation (nginx -t) before applying.
4. Graceful reloads, host toggling (active <-> disabled), and deletion.
5. Real-time access & error log streaming with HTTP response status breakdown.
"""

import os
import re
import glob
import time
import shutil
import asyncio
import logging
import subprocess
from typing import Dict, Any, List, Optional
from datetime import datetime, timezone

logger = logging.getLogger("pulseops.proxy")

NGINX_CONF_DIRS = [
    "/etc/nginx/conf.d",
    "/etc/nginx/sites-enabled",
    "/etc/nginx/sites-available"
]

FALLBACK_CONF_DIR = os.path.abspath("./conf.d")


def _detect_engine() -> Dict[str, Any]:
    """Detect available reverse proxy engines on host."""
    for bin_path in ("/usr/sbin/nginx", "/usr/bin/nginx", "/usr/local/sbin/nginx"):
        if os.path.isfile(bin_path) and os.access(bin_path, os.X_OK):
            # Check version
            ver = "Unknown"
            try:
                p = subprocess.run([bin_path, "-v"], capture_output=True, text=True, timeout=3)
                out = p.stderr or p.stdout
                m = re.search(r"nginx/([0-9.]+)", out)
                if m:
                    ver = m.group(1)
            except Exception:
                pass

            # Check if active
            is_active = False
            try:
                p = subprocess.run(["systemctl", "is-active", "nginx"], capture_output=True, text=True, timeout=3)
                is_active = p.stdout.strip() == "active"
            except Exception:
                pass

            return {
                "engine": "nginx",
                "binary": bin_path,
                "version": ver,
                "is_active": is_active,
                "conf_dir": "/etc/nginx/conf.d" if os.path.isdir("/etc/nginx/conf.d") else "/etc/nginx"
            }

    # Check Caddy
    for bin_path in ("/usr/bin/caddy", "/usr/local/bin/caddy"):
        if os.path.isfile(bin_path) and os.access(bin_path, os.X_OK):
            return {
                "engine": "caddy",
                "binary": bin_path,
                "version": "Installed",
                "is_active": False,
                "conf_dir": "/etc/caddy"
            }

    # Check Apache
    for bin_path in ("/usr/sbin/httpd", "/usr/sbin/apache2"):
        if os.path.isfile(bin_path) and os.access(bin_path, os.X_OK):
            return {
                "engine": "apache",
                "binary": bin_path,
                "version": "Installed",
                "is_active": False,
                "conf_dir": "/etc/httpd/conf.d" if os.path.isdir("/etc/httpd/conf.d") else "/etc/apache2"
            }

    return {
        "engine": "none",
        "binary": None,
        "version": None,
        "is_active": False,
        "conf_dir": None
    }


def _parse_nginx_server_block(content: str, filepath: str) -> List[Dict[str, Any]]:
    """Parse server blocks out of an Nginx config file."""
    hosts = []
    is_disabled = filepath.endswith(".disabled")

    # Match server { ... } blocks
    # Simple nested block extraction
    blocks = re.findall(r'server\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', content, re.DOTALL)
    if not blocks:
        # Try raw match if regex recursion limit hit
        blocks = [content]

    for idx, block in enumerate(blocks):
        # Server names
        sn_match = re.search(r'server_name\s+([^;]+);', block)
        server_names = sn_match.group(1).split() if sn_match else ["_"]
        primary_domain = server_names[0] if server_names else "default"

        # Listen ports
        listen_matches = re.findall(r'listen\s+([^;]+);', block)
        ports = []
        has_ssl = False
        is_default = False
        for l in listen_matches:
            if "ssl" in l or "443" in l:
                has_ssl = True
            if "default_server" in l:
                is_default = True
            # Extract port digits
            p_digits = re.findall(r'\b\d+\b', l)
            for d in p_digits:
                ports.append(int(d))
        ports = sorted(list(set(ports))) if ports else [80]

        # Proxy pass target
        pp_match = re.search(r'proxy_pass\s+([^;]+);', block)
        upstream = pp_match.group(1).strip() if pp_match else None

        # Websocket support
        has_websocket = bool(re.search(r'proxy_set_header\s+Upgrade', block, re.IGNORECASE))

        # Client max body size
        body_match = re.search(r'client_max_body_size\s+([^;]+);', block)
        max_body = body_match.group(1).strip() if body_match else "default"

        host_id = f"{os.path.basename(filepath)}#{idx}"
        hosts.append({
            "id": host_id,
            "filename": os.path.basename(filepath),
            "filepath": filepath,
            "is_enabled": not is_disabled,
            "is_default": is_default,
            "primary_domain": primary_domain,
            "server_names": server_names,
            "ports": ports,
            "has_ssl": has_ssl,
            "upstream": upstream,
            "has_websocket": has_websocket,
            "max_body": max_body,
            "raw_config": block.strip()
        })

    return hosts


def list_proxy_hosts_sync() -> Dict[str, Any]:
    """Scan configuration directories and return all virtual hosts."""
    engine_info = _detect_engine()
    hosts = []

    conf_files: List[str] = []
    for d in NGINX_CONF_DIRS:
        if os.path.isdir(d):
            conf_files.extend(glob.glob(os.path.join(d, "*.conf")))
            conf_files.extend(glob.glob(os.path.join(d, "*.conf.disabled")))

    # Also add main nginx.conf if no conf.d
    if not conf_files and os.path.isfile("/etc/nginx/nginx.conf"):
        conf_files.append("/etc/nginx/nginx.conf")

    for fpath in sorted(set(conf_files)):
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            parsed = _parse_nginx_server_block(content, fpath)
            hosts.extend(parsed)
        except Exception as e:
            logger.warning(f"Failed to parse proxy conf {fpath}: {e}")

    return {
        "success": True,
        "engine": engine_info,
        "total_hosts": len(hosts),
        "active_hosts": sum(1 for h in hosts if h["is_enabled"]),
        "hosts": hosts
    }


def test_proxy_syntax_sync() -> Dict[str, Any]:
    """Execute nginx -t or caddy validate to verify configuration syntax."""
    engine = _detect_engine()
    if engine["engine"] == "nginx" and engine["binary"]:
        try:
            proc = subprocess.run([engine["binary"], "-t"], capture_output=True, text=True, timeout=5)
            return {
                "success": proc.returncode == 0,
                "engine": "nginx",
                "returncode": proc.returncode,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "message": "Nginx configuration syntax is OK." if proc.returncode == 0 else "Nginx syntax test failed!"
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    return {"success": False, "error": "Supported proxy engine not found"}


def reload_proxy_sync() -> Dict[str, Any]:
    """Gracefully reload reverse proxy daemon."""
    # First verify syntax before attempting reload!
    test_res = test_proxy_syntax_sync()
    if not test_res.get("success"):
        return {
            "success": False,
            "error": "Cannot reload proxy — configuration syntax test failed!",
            "details": test_res.get("stderr") or test_res.get("stdout")
        }

    try:
        proc = subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True, timeout=10)
        if proc.returncode == 0:
            return {"success": True, "message": "Nginx reloaded successfully without dropping connections."}
        else:
            return {"success": False, "error": f"Failed to reload Nginx: {proc.stderr}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def create_proxy_host_sync(
    domain: str,
    forward_host: str,
    forward_port: int,
    forward_scheme: str = "http",
    enable_ssl: bool = False,
    ssl_cert_path: str = "",
    ssl_key_path: str = "",
    enable_websocket: bool = True,
    max_body_size: str = "128M"
) -> Dict[str, Any]:
    """
    Generate and apply a new reverse proxy virtual host file with automatic syntax verification.
    """
    clean_domain = domain.strip().lower()
    if not clean_domain or not re.match(r"^[a-zA-Z0-9.-]+$", clean_domain):
        return {"success": False, "error": "Invalid domain name format."}

    upstream_url = f"{forward_scheme}://{forward_host}:{forward_port}"

    # Target directory
    target_dir = "/etc/nginx/conf.d"
    if not os.path.isdir(target_dir):
        try:
            os.makedirs(target_dir, exist_ok=True)
        except Exception:
            target_dir = FALLBACK_CONF_DIR
            os.makedirs(target_dir, exist_ok=True)

    safe_filename = f"pulseops_{clean_domain.replace('.', '_')}.conf"
    target_path = os.path.join(target_dir, safe_filename)
    tmp_path = target_path + ".tmp"

    # Template config
    ws_block = ""
    if enable_websocket:
        ws_block = """
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
"""

    ssl_block = ""
    listen_block = """    listen 80;
    listen [::]:80;"""
    if enable_ssl and ssl_cert_path and ssl_key_path and os.path.isfile(ssl_cert_path):
        listen_block = """    listen 80;
    listen [::]:80;
    listen 443 ssl http2;
    listen [::]:443 ssl http2;"""
        ssl_block = f"""
    ssl_certificate {ssl_cert_path};
    ssl_certificate_key {ssl_key_path};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
"""

    conf_content = f"""# PulseOps Reverse Proxy Host — {clean_domain}
# Generated on {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}

server {{
{listen_block}
    server_name {clean_domain};

    client_max_body_size {max_body_size};
{ssl_block}
    location / {{
        proxy_pass {upstream_url};{ws_block}
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }}
}}
"""

    try:
        # Write to temp file first
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(conf_content)

        # Move to actual target path temporarily to test with nginx -t
        shutil.move(tmp_path, target_path)

        # Test syntax
        test_res = test_proxy_syntax_sync()
        if not test_res.get("success"):
            # Syntax failed! Revert immediately
            if os.path.isfile(target_path):
                os.remove(target_path)
            return {
                "success": False,
                "error": "Nginx configuration syntax validation failed. Reverted changes.",
                "details": test_res.get("stderr") or test_res.get("stdout")
            }

        # Reload Nginx gracefully
        reload_res = reload_proxy_sync()

        return {
            "success": True,
            "filename": safe_filename,
            "filepath": target_path,
            "domain": clean_domain,
            "upstream": upstream_url,
            "reload": reload_res,
            "message": f"Reverse proxy host '{clean_domain}' created and activated successfully."
        }
    except Exception as e:
        if os.path.isfile(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        return {"success": False, "error": str(e)}


def toggle_proxy_host_sync(filename: str) -> Dict[str, Any]:
    """Toggle a host between active (.conf) and disabled (.conf.disabled)."""
    # Find the file in conf directories
    found_path = None
    for d in NGINX_CONF_DIRS:
        for ext in (".conf", ".conf.disabled"):
            candidate = os.path.join(d, filename)
            if os.path.isfile(candidate):
                found_path = candidate
                break
        if found_path:
            break

    if not found_path:
        return {"success": False, "error": f"Configuration file {filename} not found."}

    if found_path.endswith(".disabled"):
        new_path = found_path[:-9]  # remove .disabled
        action = "enabled"
    else:
        new_path = found_path + ".disabled"
        action = "disabled"

    try:
        shutil.move(found_path, new_path)

        # Test syntax
        test_res = test_proxy_syntax_sync()
        if not test_res.get("success"):
            # Rollback
            shutil.move(new_path, found_path)
            return {
                "success": False,
                "error": "Nginx syntax error when toggling host. Rolled back.",
                "details": test_res.get("stderr")
            }

        reload_proxy_sync()
        return {
            "success": True,
            "action": action,
            "filename": os.path.basename(new_path),
            "message": f"Proxy host {action} successfully."
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def delete_proxy_host_sync(filename: str) -> Dict[str, Any]:
    """Permanently delete a proxy host config file and reload."""
    found_path = None
    for d in NGINX_CONF_DIRS:
        for ext in ("", ".conf", ".conf.disabled"):
            candidate = os.path.join(d, filename + ext if not filename.endswith(ext) else filename)
            if os.path.isfile(candidate):
                found_path = candidate
                break
        if found_path:
            break

    if not found_path:
        return {"success": False, "error": f"File {filename} not found."}

    # Don't delete main nginx.conf!
    if os.path.basename(found_path) == "nginx.conf":
        return {"success": False, "error": "Cannot delete root nginx.conf!"}

    try:
        os.remove(found_path)
        test_res = test_proxy_syntax_sync()
        if test_res.get("success"):
            reload_proxy_sync()
        return {
            "success": True,
            "message": f"Proxy configuration {filename} removed successfully."
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_proxy_logs_sync(lines: int = 50) -> Dict[str, Any]:
    """Read recent Nginx access and error log lines."""
    access_logs: List[str] = []
    error_logs: List[str] = []
    status_counts = {"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0}

    # Access log
    access_path = "/var/log/nginx/access.log"
    if os.path.isfile(access_path):
        try:
            p = subprocess.run(["tail", "-n", str(lines), access_path], capture_output=True, text=True)
            for line in p.stdout.splitlines():
                if line.strip():
                    access_logs.append(line.strip())
                    # Parse status code e.g. "HTTP/1.1" 200
                    sc_match = re.search(r'"\s+(\d{3})\s+', line)
                    if sc_match:
                        code = int(sc_match.group(1))
                        if 200 <= code < 300: status_counts["2xx"] += 1
                        elif 300 <= code < 400: status_counts["3xx"] += 1
                        elif 400 <= code < 500: status_counts["4xx"] += 1
                        elif 500 <= code < 600: status_counts["5xx"] += 1
        except Exception as e:
            logger.debug(f"Failed to read access log: {e}")

    # Error log
    error_path = "/var/log/nginx/error.log"
    if os.path.isfile(error_path):
        try:
            p = subprocess.run(["tail", "-n", str(lines), error_path], capture_output=True, text=True)
            error_logs = [l.strip() for l in p.stdout.splitlines() if l.strip()]
        except Exception as e:
            logger.debug(f"Failed to read error log: {e}")

    return {
        "success": True,
        "access_logs": access_logs[-lines:],
        "error_logs": error_logs[-lines:],
        "status_counts": status_counts
    }


# ─── Async APIs ──────────────────────────────────────────────────────────────

async def list_proxy_hosts() -> Dict[str, Any]:
    return await asyncio.to_thread(list_proxy_hosts_sync)

async def test_proxy_syntax() -> Dict[str, Any]:
    return await asyncio.to_thread(test_proxy_syntax_sync)

async def reload_proxy() -> Dict[str, Any]:
    return await asyncio.to_thread(reload_proxy_sync)

async def create_proxy_host(
    domain: str, forward_host: str, forward_port: int, forward_scheme: str = "http",
    enable_ssl: bool = False, ssl_cert_path: str = "", ssl_key_path: str = "",
    enable_websocket: bool = True, max_body_size: str = "128M"
) -> Dict[str, Any]:
    return await asyncio.to_thread(
        create_proxy_host_sync, domain, forward_host, forward_port, forward_scheme,
        enable_ssl, ssl_cert_path, ssl_key_path, enable_websocket, max_body_size
    )

async def toggle_proxy_host(filename: str) -> Dict[str, Any]:
    return await asyncio.to_thread(toggle_proxy_host_sync, filename)

async def delete_proxy_host(filename: str) -> Dict[str, Any]:
    return await asyncio.to_thread(delete_proxy_host_sync, filename)

async def get_proxy_logs(lines: int = 50) -> Dict[str, Any]:
    return await asyncio.to_thread(get_proxy_logs_sync, lines)
