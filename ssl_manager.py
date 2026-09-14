"""
ssl_manager.py — PulseOps Enterprise SSL/TLS Certificate & Domain Health Manager

Provides:
1. Local host SSL certificate discovery and x509 metadata extraction.
2. Live TLS probe for any host/port with cipher suite, protocol, and latency analysis.
3. Monitored domain watchlist management with automatic expiry calculation.
4. Certbot / Let's Encrypt renewal status verification.
"""

import os
import re
import ssl
import time
import socket
import logging
import sqlite3
import subprocess
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple

logger = logging.getLogger("pulseops.ssl")

DB_PATH = os.environ.get("DB_PATH", "./pulseops.db")

# Common directories where certificates reside on Linux systems
SEARCH_DIRS = [
    "/etc/letsencrypt/live",
    "/etc/pki/tls/certs",
    "/etc/ssl/certs",
    "/etc/nginx/ssl",
    "/etc/nginx/certs",
    "/etc/httpd/ssl",
    "/etc/apache2/ssl"
]

# CA bundles and trust files to exclude from application cert listing
EXCLUDE_FILENAMES = {
    "ca-bundle.crt", "ca-bundle.trust.crt", "ca-certificates.crt",
    "cert.pem", "trust-bundle.crt"
}


def _get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _parse_openssl_date(date_str: str) -> Optional[datetime]:
    """Parse dates like 'Sep  3 16:27:38 2027 GMT'."""
    if not date_str:
        return None
    cleaned = ' '.join(date_str.split()).strip()
    for fmt in ("%b %d %H:%M:%S %Y %Z", "%b %d %H:%M:%S %Y", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(cleaned, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except Exception:
            continue
    return None


def parse_cert_file(file_path: str) -> Optional[Dict[str, Any]]:
    """Parse local certificate file using openssl x509 command."""
    if not os.path.isfile(file_path) or not os.access(file_path, os.R_OK):
        return None

    cmd = [
        "openssl", "x509", "-in", file_path, "-noout",
        "-subject", "-issuer", "-dates", "-serial", "-fingerprint", "-sha256"
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if proc.returncode != 0:
            return None
        raw = proc.stdout

        # Extract subject
        subj_match = re.search(r'subject=\s*(.+)', raw)
        subj_raw = subj_match.group(1).strip() if subj_match else ""
        cn_match = re.search(r'(?:CN\s*=\s*|commonName\s*=\s*)([^,/\n]+)', subj_raw)
        subject_cn = cn_match.group(1).strip() if cn_match else subj_raw

        # Extract issuer
        iss_match = re.search(r'issuer=\s*(.+)', raw)
        iss_raw = iss_match.group(1).strip() if iss_match else ""
        iss_cn = re.search(r'(?:O\s*=\s*|CN\s*=\s*)([^,/\n]+)', iss_raw)
        issuer_name = iss_cn.group(1).strip() if iss_cn else iss_raw

        # Extract dates
        nb_match = re.search(r'notBefore=\s*(.+)', raw)
        na_match = re.search(r'notAfter=\s*(.+)', raw)
        not_before = _parse_openssl_date(nb_match.group(1)) if nb_match else None
        not_after = _parse_openssl_date(na_match.group(1)) if na_match else None

        now = datetime.now(timezone.utc)
        days_remaining = (not_after - now).days if not_after else None
        is_expired = days_remaining is not None and days_remaining <= 0

        # Status
        if is_expired:
            status = "expired"
        elif days_remaining is not None and days_remaining <= 7:
            status = "critical"
        elif days_remaining is not None and days_remaining <= 30:
            status = "warning"
        else:
            status = "valid"

        # Serial
        ser_match = re.search(r'serial=\s*(.+)', raw)
        serial = ser_match.group(1).strip() if ser_match else ""

        # Fingerprint
        fp_match = re.search(r'fingerprint=\s*(.+)', raw, re.IGNORECASE)
        fingerprint = fp_match.group(1).strip() if fp_match else ""

        # SANS
        sans = []
        try:
            san_proc = subprocess.run(
                ["openssl", "x509", "-in", file_path, "-noout", "-ext", "subjectAltName"],
                capture_output=True, text=True, timeout=3
            )
            if san_proc.returncode == 0:
                dns_matches = re.findall(r'DNS:([^,\s]+)', san_proc.stdout)
                ip_matches = re.findall(r'IP Address:([^,\s]+)', san_proc.stdout)
                sans = dns_matches + ip_matches
        except Exception:
            pass

        is_self_signed = (subj_raw == iss_raw) if subj_raw and iss_raw else False

        return {
            "file_path": file_path,
            "file_name": os.path.basename(file_path),
            "file_size": os.path.getsize(file_path),
            "subject_cn": subject_cn or os.path.basename(file_path),
            "subject_raw": subj_raw,
            "issuer": issuer_name,
            "issuer_raw": iss_raw,
            "not_before": not_before.strftime("%Y-%m-%d %H:%M:%S UTC") if not_before else None,
            "not_after": not_after.strftime("%Y-%m-%d %H:%M:%S UTC") if not_after else None,
            "days_remaining": days_remaining,
            "is_expired": is_expired,
            "is_self_signed": is_self_signed,
            "status": status,
            "serial": serial,
            "fingerprint": fingerprint,
            "sans": sans
        }
    except Exception as e:
        logger.debug("Failed parsing cert file %s: %s", file_path, e)
        return None


def scan_host_certificates() -> List[Dict[str, Any]]:
    """Scan local host filesystem for application and service certificates."""
    certs = []
    seen_paths = set()

    for d in SEARCH_DIRS:
        if not os.path.isdir(d):
            continue
        try:
            for root, _, files in os.walk(d, followlinks=False):
                # Avoid scanning endless directory-hash bundles
                if "directory-hash" in root or "ca-trust" in root:
                    continue
                for f in files:
                    if not (f.endswith(".crt") or f.endswith(".pem") or f.endswith(".cer")):
                        continue
                    if f in EXCLUDE_FILENAMES:
                        continue
                    full_path = os.path.join(root, f)
                    if full_path in seen_paths:
                        continue
                    seen_paths.add(full_path)

                    parsed = parse_cert_file(full_path)
                    if parsed:
                        certs.append(parsed)
        except Exception as e:
            logger.debug("Error walking %s: %s", d, e)

    # Deduplicate by SHA256 fingerprint if identical certs are symlinked
    unique_certs = []
    seen_fps = set()
    for c in certs:
        fp = c.get("fingerprint") or c.get("file_path")
        if fp not in seen_fps:
            seen_fps.add(fp)
            unique_certs.append(c)

    # Sort: Expired first, then fewest days remaining
    unique_certs.sort(key=lambda c: (c.get("days_remaining") is None, c.get("days_remaining", 99999)))
    return unique_certs


def probe_tls_endpoint(host_input: str, port: int = 443, timeout: float = 4.0) -> Dict[str, Any]:
    """
    Perform a live TLS handshake probe to inspect remote or local certificate.
    Supports both standard verified certificates and self-signed certificates.
    """
    clean_host = host_input.strip()
    clean_host = re.sub(r'^https?://', '', clean_host).split('/')[0].strip()

    if ':' in clean_host:
        parts = clean_host.split(':')
        clean_host = parts[0]
        try:
            port = int(parts[1])
        except ValueError:
            pass

    if not clean_host:
        return {"success": False, "error": "Invalid host"}

    t0 = time.time()
    trusted = True
    verify_error = None
    cert_info = {}
    tls_version = None
    cipher_name = None
    cipher_bits = None
    latency_ms = None

    # Step 1: Attempt standard verified handshake
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((clean_host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=clean_host) as ssock:
                cert = ssock.getpeercert()
                cipher = ssock.cipher()
                tls_version = ssock.version()
                latency_ms = round((time.time() - t0) * 1000, 1)

                if cipher:
                    cipher_name = cipher[0]
                    cipher_bits = cipher[2]

                # Parse verified cert dict
                subject_entries = cert.get("subject", ())
                subject_cn = ""
                for entry in subject_entries:
                    for k, v in entry:
                        if k == "commonName":
                            subject_cn = v

                issuer_entries = cert.get("issuer", ())
                issuer_name = ""
                for entry in issuer_entries:
                    for k, v in entry:
                        if k in ("organizationName", "commonName") and not issuer_name:
                            issuer_name = v

                not_before = _parse_openssl_date(cert.get("notBefore", ""))
                not_after = _parse_openssl_date(cert.get("notAfter", ""))
                now = datetime.now(timezone.utc)
                days_remaining = (not_after - now).days if not_after else None
                is_expired = days_remaining is not None and days_remaining <= 0

                sans = [v for k, v in cert.get("subjectAltName", []) if k in ("DNS", "IP Address")]

                status = "valid"
                if is_expired:
                    status = "expired"
                elif days_remaining is not None and days_remaining <= 7:
                    status = "critical"
                elif days_remaining is not None and days_remaining <= 30:
                    status = "warning"

                return {
                    "success": True,
                    "host": clean_host,
                    "port": port,
                    "trusted": True,
                    "status": status,
                    "subject_cn": subject_cn or clean_host,
                    "issuer": issuer_name or "Unknown",
                    "not_before": not_before.strftime("%Y-%m-%d %H:%M:%S UTC") if not_before else None,
                    "not_after": not_after.strftime("%Y-%m-%d %H:%M:%S UTC") if not_after else None,
                    "days_remaining": days_remaining,
                    "is_expired": is_expired,
                    "is_self_signed": False,
                    "sans": sans[:20],
                    "serial": cert.get("serialNumber", ""),
                    "tls_version": tls_version,
                    "cipher": cipher_name,
                    "cipher_bits": cipher_bits,
                    "latency_ms": latency_ms,
                    "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
                }
    except ssl.SSLCertVerificationError as e:
        trusted = False
        verify_error = str(e)
    except Exception as e:
        # Fallback to unverified attempt if verification failed
        verify_error = str(e)
        trusted = False

    # Step 2: Fallback to unverified context to extract certificate details even if self-signed
    try:
        u_ctx = ssl._create_unverified_context()
        t1 = time.time()
        with socket.create_connection((clean_host, port), timeout=timeout) as sock:
            with u_ctx.wrap_socket(sock, server_hostname=clean_host) as ssock:
                der_cert = ssock.getpeercert(binary_form=True)
                cipher = ssock.cipher()
                tls_version = ssock.version()
                latency_ms = round((time.time() - t1) * 1000, 1)
                if cipher:
                    cipher_name = cipher[0]
                    cipher_bits = cipher[2]

                pem_cert = ssl.DER_cert_to_PEM_cert(der_cert)
                proc = subprocess.run(
                    ["openssl", "x509", "-noout", "-subject", "-issuer", "-dates", "-serial"],
                    input=pem_cert, text=True, capture_output=True, timeout=3
                )
                raw = proc.stdout

                subj_match = re.search(r'subject=\s*(.+)', raw)
                subj_raw = subj_match.group(1).strip() if subj_match else ""
                cn_match = re.search(r'(?:CN\s*=\s*|commonName\s*=\s*)([^,/\n]+)', subj_raw)
                subject_cn = cn_match.group(1).strip() if cn_match else clean_host

                iss_match = re.search(r'issuer=\s*(.+)', raw)
                iss_raw = iss_match.group(1).strip() if iss_match else ""
                iss_cn = re.search(r'(?:O\s*=\s*|CN\s*=\s*)([^,/\n]+)', iss_raw)
                issuer_name = iss_cn.group(1).strip() if iss_cn else iss_raw

                nb_match = re.search(r'notBefore=\s*(.+)', raw)
                na_match = re.search(r'notAfter=\s*(.+)', raw)
                not_before = _parse_openssl_date(nb_match.group(1)) if nb_match else None
                not_after = _parse_openssl_date(na_match.group(1)) if na_match else None

                now = datetime.now(timezone.utc)
                days_remaining = (not_after - now).days if not_after else None
                is_expired = days_remaining is not None and days_remaining <= 0
                is_self_signed = (subj_raw == iss_raw) if subj_raw and iss_raw else True

                status = "warning" if not is_expired else "expired"
                if is_self_signed:
                    status = "self_signed"

                ser_match = re.search(r'serial=\s*(.+)', raw)
                serial = ser_match.group(1).strip() if ser_match else ""

                return {
                    "success": True,
                    "host": clean_host,
                    "port": port,
                    "trusted": False,
                    "verify_error": verify_error or "Certificate is not trusted by system CA store",
                    "status": status,
                    "subject_cn": subject_cn,
                    "issuer": issuer_name or "Self-Signed",
                    "not_before": not_before.strftime("%Y-%m-%d %H:%M:%S UTC") if not_before else None,
                    "not_after": not_after.strftime("%Y-%m-%d %H:%M:%S UTC") if not_after else None,
                    "days_remaining": days_remaining,
                    "is_expired": is_expired,
                    "is_self_signed": is_self_signed,
                    "sans": [],
                    "serial": serial,
                    "tls_version": tls_version,
                    "cipher": cipher_name,
                    "cipher_bits": cipher_bits,
                    "latency_ms": latency_ms,
                    "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
                }
    except Exception as final_err:
        return {
            "success": False,
            "host": clean_host,
            "port": port,
            "error": f"TLS Handshake failed: {final_err}"
        }


# ─── Monitored Domains Watchlist ──────────────────────────────────────────────

def list_monitored_domains() -> List[Dict[str, Any]]:
    """Retrieve all monitored SSL endpoints from SQLite database."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM ssl_monitored_domains ORDER BY id DESC")
        rows = [dict(r) for r in cur.fetchall()]
        return rows
    finally:
        conn.close()


def add_monitored_domain(host: str, port: int = 443, label: str = "", server_id: str = "local-master") -> Dict[str, Any]:
    """Add a new domain to the SSL monitoring watchlist and perform immediate probe."""
    clean_host = host.strip()
    clean_host = re.sub(r'^https?://', '', clean_host).split('/')[0].strip()
    if ':' in clean_host:
        parts = clean_host.split(':')
        clean_host = parts[0]
        try:
            port = int(parts[1])
        except ValueError:
            pass

    probe = probe_tls_endpoint(clean_host, port=port)

    conn = _get_db()
    try:
        cur = conn.cursor()
        # Check if exists
        cur.execute("SELECT id FROM ssl_monitored_domains WHERE host = ? AND port = ?", (clean_host, port))
        existing = cur.fetchone()
        if existing:
            # Update existing
            cur.execute("""
                UPDATE ssl_monitored_domains
                SET label = ?, last_status = ?, last_checked = ?, days_remaining = ?,
                    issuer = ?, subject_cn = ?, tls_version = ?, cipher = ?, latency_ms = ?
                WHERE id = ?
            """, (
                label or clean_host,
                probe.get("status", "unknown"),
                probe.get("checked_at"),
                probe.get("days_remaining"),
                probe.get("issuer"),
                probe.get("subject_cn"),
                probe.get("tls_version"),
                probe.get("cipher"),
                probe.get("latency_ms"),
                existing["id"]
            ))
            conn.commit()
            return {"success": True, "id": existing["id"], "probe": probe}

        cur.execute("""
            INSERT INTO ssl_monitored_domains (
                host, port, label, server_id, last_status, last_checked,
                days_remaining, issuer, subject_cn, tls_version, cipher, latency_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            clean_host,
            port,
            label or clean_host,
            server_id,
            probe.get("status", "unknown"),
            probe.get("checked_at"),
            probe.get("days_remaining"),
            probe.get("issuer"),
            probe.get("subject_cn"),
            probe.get("tls_version"),
            probe.get("cipher"),
            probe.get("latency_ms")
        ))
        conn.commit()
        return {"success": True, "id": cur.lastrowid, "probe": probe}
    finally:
        conn.close()


def delete_monitored_domain(domain_id: int) -> bool:
    """Delete domain from watchlist."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM ssl_monitored_domains WHERE id = ?", (domain_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def refresh_monitored_domain(domain_id: int) -> Dict[str, Any]:
    """Re-probe an existing monitored domain and update database record."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM ssl_monitored_domains WHERE id = ?", (domain_id,))
        row = cur.fetchone()
        if not row:
            return {"success": False, "error": "Domain not found"}

        host = row["host"]
        port = row["port"]
        probe = probe_tls_endpoint(host, port=port)

        cur.execute("""
            UPDATE ssl_monitored_domains
            SET last_status = ?, last_checked = ?, days_remaining = ?,
                issuer = ?, subject_cn = ?, tls_version = ?, cipher = ?, latency_ms = ?
            WHERE id = ?
        """, (
            probe.get("status", "unknown"),
            probe.get("checked_at"),
            probe.get("days_remaining"),
            probe.get("issuer"),
            probe.get("subject_cn"),
            probe.get("tls_version"),
            probe.get("cipher"),
            probe.get("latency_ms"),
            domain_id
        ))
        conn.commit()
        return {"success": True, "probe": probe}
    finally:
        conn.close()


def check_certbot_status() -> Dict[str, Any]:
    """Check if certbot is installed and report Let's Encrypt managed certificates."""
    certbot_bin = None
    for path in ("/usr/bin/certbot", "/usr/local/bin/certbot", "/snap/bin/certbot"):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            certbot_bin = path
            break

    if not certbot_bin:
        # Check in PATH
        proc = subprocess.run(["which", "certbot"], capture_output=True, text=True)
        if proc.returncode == 0 and proc.stdout.strip():
            certbot_bin = proc.stdout.strip()

    if not certbot_bin:
        return {
            "installed": False,
            "message": "Certbot is not installed on this host."
        }

    try:
        proc = subprocess.run([certbot_bin, "certificates"], capture_output=True, text=True, timeout=10)
        output = proc.stdout
        return {
            "installed": True,
            "binary": certbot_bin,
            "certificates_output": output,
            "has_certs": "Certificate Name:" in output
        }
    except Exception as e:
        return {
            "installed": True,
            "binary": certbot_bin,
            "error": str(e)
        }
