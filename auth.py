"""
auth.py — PulseOps Enterprise Authentication & Authorization Module.

Provides JWT token issuance/validation, bcrypt password hashing, session
management, brute-force protection, and role-based access control decorators.
"""

import os
import time
import uuid
import logging
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Callable

logger = logging.getLogger("pulseops.auth")

def _get_persistent_secret(env_var: str, filename: str, prefix: str) -> str:
    val = os.environ.get(env_var)
    if val:
        return val
    filepath = os.path.join(os.path.dirname(__file__), filename)
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content:
                    return content
        except Exception:
            pass
    import secrets
    generated = f"{prefix}-{secrets.token_hex(32)}"
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(generated)
        os.chmod(filepath, 0o600)
    except Exception:
        pass
    return generated

SECRET_KEY = _get_persistent_secret("SECRET_KEY", ".secret_key", "pulseops-secret")
REFRESH_SECRET_KEY = _get_persistent_secret("REFRESH_SECRET_KEY", ".refresh_secret_key", "pulseops-refresh")
ACCESS_TOKEN_EXPIRE_HOURS = int(os.environ.get("SESSION_TIMEOUT_HOURS", "24"))
REFRESH_TOKEN_EXPIRE_DAYS = 30

# In-memory rate limiting: {ip: [timestamp, ...]}
_login_attempts: Dict[str, list] = {}
_rate_limit_lock = asyncio.Lock()

# --- Dependency availability checks ---
try:
    import jwt as pyjwt
    JWT_AVAILABLE = True
except ImportError:
    JWT_AVAILABLE = False
    logger.warning("[Auth] PyJWT not installed — authentication disabled. Run: pip install PyJWT")

try:
    from passlib.context import CryptContext
    _pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
    BCRYPT_AVAILABLE = True
except ImportError:
    BCRYPT_AVAILABLE = False
    logger.warning("[Auth] passlib not installed — password hashing unavailable. Run: pip install passlib[bcrypt]")


# ─── Password Hashing ────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    """Hash a plaintext password using bcrypt.

    Returns:
        bcrypt hash string, or UNSAFE: fallback.
    """
    try:
        import bcrypt as _bcrypt
        return _bcrypt.hashpw(plain.encode("utf-8")[:72], _bcrypt.gensalt(12)).decode()
    except Exception:
        pass
    if BCRYPT_AVAILABLE:
        try:
            return _pwd_context.hash(plain.encode("utf-8")[:72].decode("utf-8", errors="ignore"))
        except Exception:
            pass
    import hashlib
    return "UNSAFE:" + hashlib.sha256(plain.encode()).hexdigest()


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a stored hash.

    Returns:
        True if password matches.
    """
    if hashed.startswith("UNSAFE:"):
        import hashlib
        return hashed == "UNSAFE:" + hashlib.sha256(plain.encode()).hexdigest()
    plain_bytes = plain.encode("utf-8")[:72]
    try:
        import bcrypt as _bcrypt
        return _bcrypt.checkpw(plain_bytes, hashed.encode("utf-8"))
    except Exception:
        pass
    if BCRYPT_AVAILABLE:
        try:
            return _pwd_context.verify(plain.encode("utf-8")[:72].decode("utf-8", errors="ignore"), hashed)
        except Exception:
            return False
    return False


# ─── JWT Token Management ─────────────────────────────────────────────────────

def create_access_token(user_id: int, email: str, role: str) -> str:
    """Create a signed JWT access token.

    Args:
        user_id: Database user ID.
        email: User email address.
        role: User role (admin|operator|viewer).

    Returns:
        Encoded JWT string.
    """
    jti = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    expire = now + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    payload = {
        "sub": str(user_id),
        "email": email,
        "role": role,
        "jti": jti,
        "iat": now,
        "exp": expire,
        "type": "access",
    }
    if JWT_AVAILABLE:
        return pyjwt.encode(payload, SECRET_KEY, algorithm="HS256")
    # Fallback: base64 JSON (NOT secure — development only)
    import base64, json
    return base64.b64encode(json.dumps(payload, default=str).encode()).decode()


def create_refresh_token(user_id: int) -> str:
    """Create a signed JWT refresh token with longer expiry.

    Args:
        user_id: Database user ID.

    Returns:
        Encoded JWT refresh token string.
    """
    jti = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    expire = now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": str(user_id),
        "jti": jti,
        "iat": now,
        "exp": expire,
        "type": "refresh",
    }
    if JWT_AVAILABLE:
        return pyjwt.encode(payload, REFRESH_SECRET_KEY, algorithm="HS256")
    import base64, json
    return base64.b64encode(json.dumps(payload, default=str).encode()).decode()


def decode_token(token: str, token_type: str = "access") -> Optional[Dict[str, Any]]:
    """Decode and validate a JWT token.

    Args:
        token: JWT token string.
        token_type: Expected token type ("access" or "refresh").

    Returns:
        Decoded payload dict, or None if invalid/expired.
    """
    try:
        if JWT_AVAILABLE:
            secret = SECRET_KEY if token_type == "access" else REFRESH_SECRET_KEY
            payload = pyjwt.decode(token, secret, algorithms=["HS256"])
            if payload.get("type") != token_type:
                return None
            return payload
        # Fallback decode
        import base64, json
        payload = json.loads(base64.b64decode(token.encode()).decode())
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


async def is_token_blacklisted(jti: str) -> bool:
    """Check if a JWT ID is in the blacklist.

    Args:
        jti: JWT unique identifier.

    Returns:
        True if token has been revoked.
    """
    try:
        from database import fetchone
        row = await fetchone("SELECT 1 FROM token_blacklist WHERE jti = ?", (jti,))
        return row is not None
    except Exception:
        return False


async def blacklist_token(jti: str, expires_at: datetime) -> None:
    """Add a JWT ID to the blacklist (logout / forced invalidation).

    Args:
        jti: JWT unique identifier to revoke.
        expires_at: Token expiry datetime (for cleanup scheduling).
    """
    try:
        from database import execute
        await execute(
            "INSERT OR IGNORE INTO token_blacklist (jti, expires_at) VALUES (?, ?)",
            (jti, expires_at.isoformat())
        )
    except Exception as e:
        logger.error("Failed to blacklist token %s: %s", jti, e)


# ─── Rate Limiting & Brute Force Protection ───────────────────────────────────

RATE_LIMIT_WINDOW = 60      # seconds
RATE_LIMIT_MAX = 5          # attempts per window
LOCKOUT_ATTEMPTS = 10       # consecutive failures before account lock
LOCKOUT_DURATION = 900      # 15 minutes in seconds


async def check_rate_limit(ip: str) -> bool:
    """Check if an IP address is within the allowed login attempt rate.

    Args:
        ip: Client IP address string.

    Returns:
        True if request is allowed, False if rate limited.
    """
    async with _rate_limit_lock:
        now = time.time()
        attempts = _login_attempts.get(ip, [])
        # Filter to window
        attempts = [t for t in attempts if now - t < RATE_LIMIT_WINDOW]
        _login_attempts[ip] = attempts
        if len(attempts) >= RATE_LIMIT_MAX:
            return False
        _login_attempts[ip].append(now)
        return True


async def record_failed_login(user_id: int, email: str, ip: str) -> bool:
    """Increment the user's failed login counter and lock if threshold reached.

    Args:
        user_id: Database user ID.
        email: User email for logging.
        ip: Client IP address.

    Returns:
        True if the account was just locked.
    """
    try:
        from database import fetchone, execute
        row = await fetchone(
            "SELECT failed_login_count FROM users WHERE id = ?", (user_id,)
        )
        if not row:
            return False
        count = (row["failed_login_count"] or 0) + 1
        locked = count >= LOCKOUT_ATTEMPTS
        locked_until = None
        if locked:
            locked_until = (
                datetime.now(timezone.utc) + timedelta(seconds=LOCKOUT_DURATION)
            ).isoformat()
            logger.warning("[Auth] Account %s locked after %d failures from %s", email, count, ip)
        await execute(
            "UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?",
            (count, locked_until, user_id)
        )
        return locked
    except Exception as e:
        logger.error("Error recording failed login: %s", e)
        return False


async def reset_failed_login(user_id: int) -> None:
    """Clear failed login counter after a successful authentication.

    Args:
        user_id: Database user ID to reset.
    """
    try:
        from database import execute
        await execute(
            "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login = datetime('now') WHERE id = ?",
            (user_id,)
        )
    except Exception as e:
        logger.error("Error resetting failed login: %s", e)


# ─── Current User Extraction ──────────────────────────────────────────────────

async def get_current_user(authorization: str) -> Optional[Dict[str, Any]]:
    """Extract and validate the current user from an Authorization header.

    Args:
        authorization: 'Bearer <token>' header value.

    Returns:
        User dict with id/email/role fields, or None if invalid.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[7:]
    payload = decode_token(token, "access")
    if not payload:
        return None
    jti = payload.get("jti", "")
    if jti and await is_token_blacklisted(jti):
        return None
    try:
        from database import fetchone
        user = await fetchone(
            "SELECT id, email, display_name, role, is_active, locked_until "
            "FROM users WHERE id = ?",
            (int(payload["sub"]),)
        )
        if not user or not user["is_active"]:
            return None
        # Check account lock
        if user.get("locked_until"):
            lock_dt = datetime.fromisoformat(user["locked_until"])
            if lock_dt.tzinfo is None:
                lock_dt = lock_dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < lock_dt:
                return None
        return {**user, "jti": jti, "exp": payload.get("exp")}
    except Exception as e:
        logger.error("Error fetching current user: %s", e)
        return None


def require_role(*allowed_roles: str) -> Callable:
    """Create a role-checking dependency for FastAPI endpoints.

    Args:
        *allowed_roles: Roles permitted to access the endpoint.

    Returns:
        Async function that validates the current user's role.

    Raises:
        HTTPException: 401 if not authenticated, 403 if wrong role.
    """
    async def dependency(authorization: str = "") -> Dict[str, Any]:
        try:
            from fastapi import HTTPException, Header
        except ImportError:
            return {}
        user = await get_current_user(authorization)
        if not user:
            raise HTTPException(status_code=401, detail="Authentication required")
        if allowed_roles and user["role"] not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail=f"Access denied — required roles: {', '.join(allowed_roles)}"
            )
        return user
    return dependency


# ─── First-Run Bootstrap ──────────────────────────────────────────────────────

DEFAULT_ADMIN_EMAIL = "admin@pulseops.local"
DEFAULT_ADMIN_PASSWORD = "PulseOps@Admin123"
DEFAULT_ADMIN_NAME = "System Administrator"


async def bootstrap_admin() -> None:
    """Create default admin account if no users exist in the database.

    Prints credentials to console on creation. Should be called once at startup.
    """
    try:
        from database import fetchone, execute
        existing = await fetchone("SELECT id FROM users LIMIT 1")
        if existing:
            return  # Users already exist

        # Use raw bcrypt directly to avoid passlib/bcrypt version detection issues
        pw_hash = _safe_hash(DEFAULT_ADMIN_PASSWORD)

        await execute(
            "INSERT INTO users (email, display_name, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?)",
            (DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_NAME, pw_hash, "admin", 1)
        )
        sep = "=" * 60
        print(f"\n{sep}")
        print("  PulseOps Enterprise -- First Run Setup")
        print(sep)
        print(f"  Default admin account created:")
        print(f"  Email   : {DEFAULT_ADMIN_EMAIL}")
        print(f"  Password: {DEFAULT_ADMIN_PASSWORD}")
        print("  WARNING: Change this password immediately after first login!")
        print(f"{sep}\n")
        logger.info("[Auth] Default admin account created: %s", DEFAULT_ADMIN_EMAIL)
    except Exception as e:
        logger.error("Failed to bootstrap admin: %s", e)


def _safe_hash(plain: str) -> str:
    """Hash a password using raw bcrypt, bypassing passlib's version check."""
    plain_bytes = plain.encode("utf-8")[:72]
    try:
        import bcrypt as _bcrypt
        return _bcrypt.hashpw(plain_bytes, _bcrypt.gensalt(12)).decode()
    except Exception:
        pass
    if BCRYPT_AVAILABLE:
        try:
            return _pwd_context.hash(plain.encode("utf-8")[:72].decode("utf-8", errors="ignore"))
        except Exception:
            pass
    import hashlib
    return "UNSAFE:" + hashlib.sha256(plain.encode()).hexdigest()


# ─── TOTP / 2FA ───────────────────────────────────────────────────────────────

def generate_totp_secret() -> Optional[str]:
    """Generate a new TOTP secret for 2FA enrollment.

    Returns:
        Base32-encoded TOTP secret, or None if pyotp not available.
    """
    try:
        import pyotp
        return pyotp.random_base32()
    except ImportError:
        logger.warning("[Auth] pyotp not installed — 2FA unavailable")
        return None


def verify_totp(secret: str, token: str) -> bool:
    """Verify a TOTP code against the stored secret.

    Args:
        secret: Base32 TOTP secret.
        token: 6-digit TOTP code provided by user.

    Returns:
        True if the code is valid.
    """
    try:
        import pyotp
        totp = pyotp.TOTP(secret)
        return totp.verify(token, valid_window=1)
    except Exception:
        return False


def get_totp_uri(secret: str, email: str, app_name: str = "PulseOps") -> str:
    """Generate an otpauth URI for QR code display.

    Args:
        secret: Base32 TOTP secret.
        email: User email for the account label.
        app_name: Application name for the issuer field.

    Returns:
        otpauth:// URI string for QR encoding.
    """
    try:
        import pyotp
        return pyotp.TOTP(secret).provisioning_uri(email, issuer_name=app_name)
    except Exception:
        return f"otpauth://totp/{app_name}:{email}?secret={secret}&issuer={app_name}"
