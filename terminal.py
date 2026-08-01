import re
import asyncio
import subprocess
from typing import Dict, Any, Optional

FORBIDDEN_COMMANDS = ['rm -rf /', 'mkfs', 'dd if=/dev/zero', ':(){ :|:& };:']

async def exec_sudo_command(cmd: str, sudo_password: Optional[str] = None, timeout: int = 15) -> Dict[str, Any]:
    execution_cmd = cmd.strip()
    is_sudo_cmd = bool(re.match(r'^\s*sudo(\s+|$)', execution_cmd))

    if sudo_password:
        if is_sudo_cmd:
            execution_cmd = re.sub(r'^\s*sudo(\s+|$)', 'sudo -S -p "" ', execution_cmd)
        else:
            execution_cmd = f'sudo -S -p "" {execution_cmd}'

        try:
            proc = await asyncio.create_subprocess_shell(
                execution_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            input_bytes = (sudo_password + '\n').encode('utf-8')
            stdout, stderr = await asyncio.wait_for(proc.communicate(input_bytes), timeout=timeout)
            
            clean_stderr = stderr.decode('utf-8', errors='ignore')
            clean_stderr = re.sub(r'\[sudo\] password for .*?:\s*', '', clean_stderr).strip()

            is_invalid_pass = any(msg in clean_stderr for msg in [
                'incorrect password', 'password is required', '3 incorrect password attempts'
            ])

            if is_invalid_pass:
                return {
                    "error": "sudo: incorrect password",
                    "requirePassword": True,
                    "isInvalidPassword": True,
                    "stdout": stdout.decode('utf-8', errors='ignore'),
                    "stderr": clean_stderr or "sudo: 1 incorrect password attempt"
                }

            if proc.returncode != 0:
                return {
                    "error": f"Command exited with code {proc.returncode}",
                    "stdout": stdout.decode('utf-8', errors='ignore'),
                    "stderr": clean_stderr
                }

            return {
                "error": None,
                "stdout": stdout.decode('utf-8', errors='ignore'),
                "stderr": clean_stderr
            }
        except asyncio.TimeoutError:
            return {"error": "Command timed out", "stdout": "", "stderr": "Execution timed out"}
        except Exception as e:
            return {"error": str(e), "stdout": "", "stderr": str(e)}

    if is_sudo_cmd:
        non_interactive_cmd = re.sub(r'^\s*sudo(\s+|$)', 'sudo -n ', execution_cmd)
        try:
            proc = await asyncio.create_subprocess_shell(
                non_interactive_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            clean_stderr = stderr.decode('utf-8', errors='ignore').strip()

            if proc.returncode == 0:
                return {"error": None, "stdout": stdout.decode('utf-8', errors='ignore'), "stderr": clean_stderr}

            is_password_req = any(msg in clean_stderr for msg in [
                'password is required', 'a terminal is required', 'no tty present', 'askpass'
            ])

            if is_password_req or proc.returncode != 0:
                return {
                    "error": "sudo: password required",
                    "requirePassword": True,
                    "stdout": stdout.decode('utf-8', errors='ignore'),
                    "stderr": clean_stderr or "sudo: a password is required to run elevated commands."
                }
        except asyncio.TimeoutError:
            return {"error": "Command timed out", "stdout": "", "stderr": "Execution timed out"}
        except Exception as e:
            return {"error": str(e), "stdout": "", "stderr": str(e)}

    # Standard non-sudo execution
    try:
        proc = await asyncio.create_subprocess_shell(
            execution_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        err_msg = None if proc.returncode == 0 else f"Exited with code {proc.returncode}"
        return {
            "error": err_msg,
            "stdout": stdout.decode('utf-8', errors='ignore'),
            "stderr": stderr.decode('utf-8', errors='ignore')
        }
    except asyncio.TimeoutError:
        return {"error": "Command timed out", "stdout": "", "stderr": "Execution timed out"}
    except Exception as e:
        return {"error": str(e), "stdout": "", "stderr": str(e)}


async def exec_terminal_command(command: str, sudo_password: Optional[str] = None) -> Dict[str, Any]:
    if not command or not isinstance(command, str):
        return {"success": False, "error": "No command provided"}

    for forbidden in FORBIDDEN_COMMANDS:
        if forbidden in command:
            return {"success": False, "error": "Command blocked by PulseOps safety policy."}

    res = await exec_sudo_command(command, sudo_password=sudo_password)

    if res.get("requirePassword"):
        return {
            "success": False,
            "requirePassword": True,
            "isInvalidPassword": bool(res.get("isInvalidPassword")),
            "error": res.get("stderr") or res.get("error") or "sudo: password required"
        }

    return {
        "success": res.get("error") is None,
        "stdout": res.get("stdout", ""),
        "stderr": res.get("stderr", ""),
        "error": res.get("error")
    }
