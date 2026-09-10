"""
users.py — PulseOps Enterprise User Management Module.

Provides async CRUD operations for user accounts, role validation, and
profile management. All writes are validated before being persisted.
"""

import logging
import re
from typing import Any, Dict, List, Optional

from auth import hash_password, verify_password

logger = logging.getLogger("pulseops.users")

VALID_ROLES = {"admin", "operator", "viewer"}
EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")
MIN_PASSWORD_LENGTH = 8


def _validate_email(email: str) -> bool:
    """Validate email format.

    Args:
        email: Email string to validate.

    Returns:
        True if format is valid.
    """
    return bool(EMAIL_RE.match(email.strip()))


def _validate_password(password: str) -> Optional[str]:
    """Validate password strength requirements.

    Args:
        password: Plaintext password to validate.

    Returns:
        Error message string if invalid, None if valid.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
    return None


async def list_users() -> List[Dict[str, Any]]:
    """Return all users (excluding sensitive fields).

    Returns:
        List of user dicts without password_hash, totp_secret fields.
    """
    from database import fetchall
    rows = await fetchall(
        "SELECT id, email, display_name, role, is_active, last_login, created_at, "
        "failed_login_count, locked_until, totp_enabled "
        "FROM users ORDER BY created_at ASC"
    )
    return rows


async def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    """Fetch a single user by ID (excluding password hash).

    Args:
        user_id: Database user ID.

    Returns:
        User dict or None if not found.
    """
    from database import fetchone
    return await fetchone(
        "SELECT id, email, display_name, role, is_active, last_login, created_at, "
        "failed_login_count, locked_until, totp_enabled "
        "FROM users WHERE id = ?",
        (user_id,)
    )


async def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    """Fetch a user by email (includes password_hash for auth).

    Args:
        email: User email address.

    Returns:
        Full user dict (including password_hash) or None.
    """
    from database import fetchone
    return await fetchone(
        "SELECT id, email, display_name, password_hash, role, is_active, "
        "last_login, failed_login_count, locked_until, totp_secret, totp_enabled, totp_backup_codes "
        "FROM users WHERE email = ?",
        (email.strip().lower(),)
    )


async def create_user(
    email: str,
    display_name: str,
    password: str,
    role: str = "viewer",
    created_by: Optional[int] = None,
) -> Dict[str, Any]:
    """Create a new user account.

    Args:
        email: User email address (must be unique).
        display_name: Human-friendly display name.
        password: Plaintext password (will be hashed).
        role: User role — one of admin/operator/viewer.
        created_by: ID of the admin user making this change.

    Returns:
        Dict with 'success' bool and either 'user_id' or 'error' key.
    """
    from database import fetchone, execute

    email = email.strip().lower()
    display_name = display_name.strip()
    role = role.strip().lower()

    if not _validate_email(email):
        return {"success": False, "error": "Invalid email address format"}
    if not display_name or len(display_name) > 100:
        return {"success": False, "error": "Display name must be 1–100 characters"}
    if role not in VALID_ROLES:
        return {"success": False, "error": f"Invalid role — must be one of: {', '.join(VALID_ROLES)}"}
    pw_error = _validate_password(password)
    if pw_error:
        return {"success": False, "error": pw_error}

    # Duplicate check
    existing = await fetchone("SELECT id FROM users WHERE email = ?", (email,))
    if existing:
        return {"success": False, "error": "Email address already registered"}

    pw_hash = hash_password(password)
    try:
        user_id = await execute(
            "INSERT INTO users (email, display_name, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)",
            (email, display_name, pw_hash, role)
        )
        logger.info("[Users] Created user %s (role=%s) by user_id=%s", email, role, created_by)
        return {"success": True, "user_id": user_id}
    except Exception as e:
        logger.error("Error creating user %s: %s", email, e)
        return {"success": False, "error": "Database error creating user"}


async def update_user(
    user_id: int,
    updates: Dict[str, Any],
    updated_by: Optional[int] = None,
) -> Dict[str, Any]:
    """Update allowed user fields.

    Args:
        user_id: Target user ID.
        updates: Dict of fields to update (email, display_name, role, is_active, password).
        updated_by: ID of admin performing the update.

    Returns:
        Dict with 'success' bool and optional 'error'.
    """
    from database import fetchone, execute

    user = await fetchone("SELECT id, email FROM users WHERE id = ?", (user_id,))
    if not user:
        return {"success": False, "error": "User not found"}

    set_clauses = []
    params = []

    if "email" in updates:
        new_email = updates["email"].strip().lower()
        if not _validate_email(new_email):
            return {"success": False, "error": "Invalid email format"}
        # Check uniqueness excluding self
        dup = await fetchone(
            "SELECT id FROM users WHERE email = ? AND id != ?", (new_email, user_id)
        )
        if dup:
            return {"success": False, "error": "Email already in use"}
        set_clauses.append("email = ?")
        params.append(new_email)

    if "display_name" in updates:
        name = updates["display_name"].strip()
        if not name or len(name) > 100:
            return {"success": False, "error": "Display name must be 1–100 characters"}
        set_clauses.append("display_name = ?")
        params.append(name)

    if "role" in updates:
        role = updates["role"].strip().lower()
        if role not in VALID_ROLES:
            return {"success": False, "error": f"Invalid role — must be one of: {', '.join(VALID_ROLES)}"}
        set_clauses.append("role = ?")
        params.append(role)

    if "is_active" in updates:
        set_clauses.append("is_active = ?")
        params.append(1 if updates["is_active"] else 0)

    if "password" in updates:
        pw_error = _validate_password(updates["password"])
        if pw_error:
            return {"success": False, "error": pw_error}
        set_clauses.append("password_hash = ?")
        params.append(hash_password(updates["password"]))
        # Reset login tracking on password change
        set_clauses.append("failed_login_count = 0")
        set_clauses.append("locked_until = NULL")

    if "unlock" in updates and updates["unlock"]:
        set_clauses.append("failed_login_count = 0")
        set_clauses.append("locked_until = NULL")

    if not set_clauses:
        return {"success": False, "error": "No valid fields to update"}

    params.append(user_id)
    sql = f"UPDATE users SET {', '.join(set_clauses)} WHERE id = ?"
    await execute(sql, tuple(params))
    logger.info("[Users] Updated user_id=%d by user_id=%s", user_id, updated_by)
    return {"success": True}


async def delete_user(user_id: int, requesting_user_id: int) -> Dict[str, Any]:
    """Deactivate a user account (soft delete).

    Args:
        user_id: Target user ID to deactivate.
        requesting_user_id: ID of admin making the request (cannot delete self).

    Returns:
        Dict with 'success' bool and optional 'error'.
    """
    from database import fetchone, execute

    if user_id == requesting_user_id:
        return {"success": False, "error": "Cannot deactivate your own account"}

    user = await fetchone("SELECT id, email FROM users WHERE id = ?", (user_id,))
    if not user:
        return {"success": False, "error": "User not found"}

    await execute(
        "UPDATE users SET is_active = 0 WHERE id = ?", (user_id,)
    )
    logger.info("[Users] Deactivated user_id=%d (%s) by user_id=%d", user_id, user["email"], requesting_user_id)
    return {"success": True}


async def authenticate_user(email: str, password: str) -> Optional[Dict[str, Any]]:
    """Verify credentials and return user data on success.

    Args:
        email: User email.
        password: Plaintext password.

    Returns:
        User dict on success, None on failure. Dict includes 'locked' key if account locked.
    """
    from datetime import datetime, timezone
    user = await get_user_by_email(email)
    if not user:
        return None

    # Account lock check
    if user.get("locked_until"):
        try:
            lock_dt = datetime.fromisoformat(user["locked_until"])
            if lock_dt.tzinfo is None:
                lock_dt = lock_dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < lock_dt:
                return {"locked": True, "locked_until": user["locked_until"]}
        except Exception:
            pass

    if not user.get("is_active"):
        return None

    if not verify_password(password, user["password_hash"]):
        return None

    return user


async def update_user_totp(user_id: int, secret: str, enabled: bool, backup_codes: Optional[str] = None) -> None:
    """Save TOTP configuration for a user.

    Args:
        user_id: Database user ID.
        secret: Base32 TOTP secret.
        enabled: Whether 2FA is now enabled.
        backup_codes: JSON-encoded list of backup recovery codes.
    """
    from database import execute
    await execute(
        "UPDATE users SET totp_secret = ?, totp_enabled = ?, totp_backup_codes = ? WHERE id = ?",
        (secret, 1 if enabled else 0, backup_codes, user_id)
    )
