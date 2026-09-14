import os
import re
import asyncio
import subprocess
from typing import Dict, Any, Optional

FORBIDDEN_COMMANDS = ['rm -rf /', 'mkfs', 'dd if=/dev/zero', ':(){ :|:& };:']

FORBIDDEN_REGEX = [
    re.compile(r'rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(/|/\*|~|\$HOME)', re.IGNORECASE),
    re.compile(r':\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:', re.IGNORECASE),
    re.compile(r'dd\s+if=/dev/(zero|urandom)\s+of=/dev/[shv]d[a-z]?', re.IGNORECASE),
    re.compile(r'mkfs(\.[a-z0-9]+)?\s+/dev/[shv]d[a-z]?$', re.IGNORECASE),
    re.compile(r'>\s*/dev/[shv]d[a-z]?$', re.IGNORECASE),
]


def is_command_forbidden(cmd: str) -> bool:
    """Check if command matches dangerous destructive patterns."""
    clean = cmd.strip()
    for forbidden in FORBIDDEN_COMMANDS:
        if forbidden in clean:
            return True
    for pattern in FORBIDDEN_REGEX:
        if pattern.search(clean):
            return True
    return False


def normalize_command(cmd: str) -> str:
    """Normalize common commands to avoid indefinite hangs (e.g. ping without count)."""
    clean = cmd.strip()
    # If ping is used without count option (-c), inject -c 4
    if re.match(r'^ping\s+', clean) and not re.search(r'\s-c\s+\d+', clean):
        clean = re.sub(r'^ping\s+', 'ping -c 4 ', clean)
    return clean


def resolve_safe_cwd(cwd: Optional[str]) -> str:
    """Ensure working directory exists and is a valid directory."""
    if not cwd or cwd == '~':
        home = os.path.expanduser('~')
        return home if os.path.isdir(home) else '/'
    if cwd.startswith('~/'):
        expanded = os.path.expanduser(cwd)
        return expanded if os.path.isdir(expanded) else '/'
    if os.path.isabs(cwd) and os.path.isdir(cwd):
        return os.path.abspath(cwd)
    return os.path.expanduser('~') if os.path.isdir(os.path.expanduser('~')) else '/'


async def exec_sudo_command(cmd: str, sudo_password: Optional[str] = None, timeout: int = 15, cwd: Optional[str] = None) -> Dict[str, Any]:
    """Execute command with sudo elevation or as current process."""
    return await exec_terminal_command(cmd, sudo_password=sudo_password, cwd=cwd, timeout=timeout)


async def exec_terminal_command(
    command: str,
    sudo_password: Optional[str] = None,
    cwd: Optional[str] = None,
    timeout: int = 15
) -> Dict[str, Any]:
    """
    Execute a terminal command within a persistent working directory context.
    Supports cd directory navigation, cwd tracking, ANSI color handling, and sudo privilege escalation.
    """
    if not command or not isinstance(command, str) or not command.strip():
        return {
            "success": True,
            "stdout": "",
            "stderr": "",
            "error": None,
            "exit_code": 0,
            "cwd": resolve_safe_cwd(cwd)
        }

    raw_cmd = command.strip()
    current_cwd = resolve_safe_cwd(cwd)

    # Friendly handle terminal exit
    if raw_cmd in ('exit', 'logout'):
        return {
            "success": True,
            "stdout": "[PulseOps] Terminal session active. Type 'clear' to clear console buffer.\n",
            "stderr": "",
            "error": None,
            "exit_code": 0,
            "cwd": current_cwd
        }

    # Block destructive commands
    if is_command_forbidden(raw_cmd):
        return {
            "success": False,
            "stdout": "",
            "stderr": "Command blocked by PulseOps safety policy.",
            "error": "Command blocked by PulseOps safety policy.",
            "exit_code": 1,
            "cwd": current_cwd
        }

    # Normalize command (e.g. ping -c 4)
    execution_cmd = normalize_command(raw_cmd)
    is_sudo_cmd = bool(re.match(r'^\s*sudo(\s+|$)', execution_cmd))
    is_root = (os.geteuid() == 0)

    # ─── Pure 'cd' command handler ──────────────────────────────
    if not re.search(r'[;&|<>]', execution_cmd):
        cd_match = re.match(r'^cd(\s+.*)?$', execution_cmd)
        if cd_match:
            target = cd_match.group(1).strip() if cd_match.group(1) else '~'
            # Handle cd ~ or cd without arguments
            if not target or target == '~':
                dest = os.path.expanduser('~')
            elif target.startswith('~/'):
                dest = os.path.expanduser(target)
            elif target == '-':
                dest = current_cwd
            elif os.path.isabs(target):
                dest = os.path.abspath(target)
            else:
                dest = os.path.abspath(os.path.join(current_cwd, target))

            if not os.path.exists(dest):
                err = f"bash: cd: {target}: No such file or directory\n"
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": err,
                    "error": err.strip(),
                    "exit_code": 1,
                    "cwd": current_cwd
                }
            if not os.path.isdir(dest):
                err = f"bash: cd: {target}: Not a directory\n"
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": err,
                    "error": err.strip(),
                    "exit_code": 1,
                    "cwd": current_cwd
                }

            return {
                "success": True,
                "stdout": "",
                "stderr": "",
                "error": None,
                "exit_code": 0,
                "cwd": dest
            }

    # ─── Pure 'pwd' command handler ─────────────────────────────
    if execution_cmd == 'pwd':
        return {
            "success": True,
            "stdout": f"{current_cwd}\n",
            "stderr": "",
            "error": None,
            "exit_code": 0,
            "cwd": current_cwd
        }

    # ─── Sudo handling ──────────────────────────────────────────
    stdin_bytes = None
    if is_sudo_cmd:
        if is_root:
            # If server is already running as root, strip sudo and run natively
            execution_cmd = re.sub(r'^\s*sudo(\s+|$)', '', execution_cmd).strip()
        elif sudo_password:
            # Non-root with sudo password provided: pipe password to sudo -S -p ""
            execution_cmd = re.sub(r'^\s*sudo(\s+|$)', 'sudo -S -p "" ', execution_cmd)
            stdin_bytes = (sudo_password + '\n').encode('utf-8')
        else:
            # Non-root without sudo password: test if passwordless sudo is permitted
            execution_cmd = re.sub(r'^\s*sudo(\s+|$)', 'sudo -n ', execution_cmd)

    # ─── Shell wrapper with CWD detection ───────────────────────
    # Wrap execution to detect if working directory changed (e.g. compound cd /var/log && ls)
    wrapped_script = (
        f"{execution_cmd}\n"
        f"__PULSE_RET__=$?\n"
        f"printf '\\n__PULSE_CWD__%s\\n' \"$(pwd -P)\"\n"
        f"exit $__PULSE_RET__"
    )

    env = os.environ.copy()
    env['PAGER'] = 'cat'
    env['TERM'] = 'xterm-256color'

    proc = None
    try:
        proc = await asyncio.create_subprocess_shell(
            wrapped_script,
            stdin=subprocess.PIPE if stdin_bytes else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=current_cwd,
            env=env
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(stdin_bytes),
            timeout=timeout
        )
    except asyncio.TimeoutError:
        if proc:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        return {
            "success": False,
            "stdout": "",
            "stderr": f"Command execution timed out after {timeout} seconds. The process was terminated.",
            "error": f"Command timed out after {timeout}s",
            "exit_code": 124,
            "cwd": current_cwd
        }
    except Exception as e:
        return {
            "success": False,
            "stdout": "",
            "stderr": str(e),
            "error": str(e),
            "exit_code": 1,
            "cwd": current_cwd
        }

    out_raw = stdout_bytes.decode('utf-8', errors='ignore')
    err_raw = stderr_bytes.decode('utf-8', errors='ignore')

    # Clean sudo password prompt artifacts from stderr
    clean_stderr = re.sub(r'\[sudo\] password for .*?:\s*', '', err_raw).strip()

    # Extract __PULSE_CWD__ marker from stdout
    new_cwd = current_cwd
    clean_lines = []
    lines = out_raw.splitlines()
    for line in lines:
        if line.startswith('__PULSE_CWD__'):
            detected = line[len('__PULSE_CWD__'):].strip()
            if detected and os.path.isdir(detected):
                new_cwd = detected
        else:
            clean_lines.append(line)
    
    clean_stdout = '\n'.join(clean_lines)
    if out_raw.endswith('\n') and not clean_stdout.endswith('\n') and clean_stdout:
        clean_stdout += '\n'

    # Check for sudo password errors if non-root
    if is_sudo_cmd and not is_root:
        if sudo_password:
            is_invalid_pass = any(msg in clean_stderr.lower() for msg in [
                'incorrect password', 'password is required', '3 incorrect password attempts'
            ])
            if is_invalid_pass:
                return {
                    "success": False,
                    "requirePassword": True,
                    "isInvalidPassword": True,
                    "error": "sudo: incorrect password",
                    "stdout": clean_stdout,
                    "stderr": clean_stderr or "sudo: incorrect password attempt",
                    "exit_code": 1,
                    "cwd": current_cwd
                }
        else:
            is_password_req = any(msg in clean_stderr.lower() for msg in [
                'password is required', 'a terminal is required', 'no tty present', 'askpass'
            ])
            if is_password_req:
                return {
                    "success": False,
                    "requirePassword": True,
                    "isInvalidPassword": False,
                    "error": "sudo: password required",
                    "stdout": clean_stdout,
                    "stderr": clean_stderr or "sudo: a password is required to run elevated commands.",
                    "exit_code": 1,
                    "cwd": current_cwd
                }

    returncode = proc.returncode if proc else 0
    err_msg = None if returncode == 0 else (clean_stderr or f"Command exited with code {returncode}")

    return {
        "success": (returncode == 0),
        "stdout": clean_stdout,
        "stderr": clean_stderr,
        "error": err_msg,
        "exit_code": returncode,
        "cwd": new_cwd
    }
