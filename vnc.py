"""
PulseOps - VNC / RFB Remote Desktop Subsystem
==============================================
Manages REAL VNC server backends and proxies raw RFB traffic to the browser
over a WebSocket tunnel (see handle_vnc_proxy in server.py / fastapi_app.py).

Supported backends (all are genuine RFB servers you could equally point
TightVNC Viewer / RealVNC Viewer / any standard VNC client at):

  * tigervnc  - TigerVNC's Xvnc server (own virtual X display + xterm apps)
  * tightvnc  - TightVNC's Xvnc-based server (Debian/Ubuntu `tightvncserver`)
  * x11vnc    - Mirrors an Xvfb virtual X display over RFB
  * auto      - Picks whichever of the above is already installed (or the
                first one this system's package manager can install)

There is intentionally NO fake/simulated "built-in" server anymore. The
previous "native" backend only drew a cartoon dashboard with Pillow and
never captured a real screen, which is why nothing was visible in the
viewer. Every backend below starts a real X server / real screen mirror
that speaks standard RFB, so any RFB client (including the bundled
web viewer, TightVNC Viewer, RealVNC Viewer, etc.) can connect to it.
"""

import os
import shutil
import asyncio
import subprocess
from typing import Dict, Any, Optional

# ── External backend process tracking ───────────────────────────────────────
_xvfb_proc: Optional[asyncio.subprocess.Process] = None
_vnc_daemon_proc: Optional[asyncio.subprocess.Process] = None
_active_backend: str = 'none'      # 'none' | 'x11vnc' | 'tigervnc' | 'tightvnc'
_active_backend_port: int = 5900
_active_display: str = ':0'

# ── Backend definitions ──────────────────────────────────────────────────────
# 'kind' selects which launcher implementation to use:
#   'xvnc'   -> self-contained Xvnc-style server (tigervnc / tightvnc)
#   'x11vnc' -> Xvfb + x11vnc mirror
BACKENDS = {
    'tigervnc': {
        'label': 'TigerVNC (Real Linux Desktop)',
        'description': 'Full real Linux desktop via TigerVNC\'s Xvnc server. Connect with this viewer, TightVNC Viewer, or RealVNC Viewer.',
        'kind': 'xvnc',
        'binaries': ['vncserver'],
        'binary_candidates': ['Xvnc', 'vncserver', 'tigervncserver', 'Xtigervnc'],
        'port': 5901,
        'install_pkgs': {
            'dnf': ['tigervnc-server', 'xterm', 'openbox'],
            'yum': ['tigervnc-server', 'xterm', 'openbox'],
            'apt-get': ['tigervnc-standalone-server', 'xterm', 'openbox'],
        },
    },
    'tightvnc': {
        'label': 'TightVNC (Real Linux Desktop)',
        'description': 'Full real Linux desktop via TightVNC / TigerVNC Xvnc server. Compatible with TightVNC Viewer and RealVNC Viewer.',
        'kind': 'xvnc',
        'binaries': ['tightvncserver'],
        'binary_candidates': ['tightvncserver', 'Xvnc', 'vncserver'],
        'port': 5903,
        'install_pkgs': {
            'dnf': ['tigervnc-server', 'xterm', 'openbox'],   # RHEL family ships TigerVNC as the vncserver provider
            'yum': ['tigervnc-server', 'xterm', 'openbox'],
            'apt-get': ['tightvncserver', 'xterm', 'openbox'],
        },
    },
    'x11vnc': {
        'label': 'x11vnc Desktop Server',
        'description': 'Real screen mirror & desktop via x11vnc on standard port 5900. Compatible with TightVNC Viewer and web client.',
        'kind': 'x11vnc',
        'binaries': ['x11vnc'],
        'binary_candidates': ['x11vnc'],
        'port': 5900,
        'install_pkgs': {
            'dnf': ['x11vnc', 'xorg-x11-server-Xvfb', 'xterm', 'openbox'],
            'yum': ['x11vnc', 'xorg-x11-server-Xvfb', 'xterm', 'openbox'],
            'apt-get': ['x11vnc', 'xvfb', 'xterm', 'openbox'],
        },
    },
}

# Preference order used by the 'auto' backend - x11vnc is premier
AUTO_ORDER = ['x11vnc', 'tigervnc', 'tightvnc']


# ────────────────────────────────────────────────────────────────────────────
# Utility helpers
# ────────────────────────────────────────────────────────────────────────────

async def check_tcp_port(host: str, port: int, timeout: float = 0.8) -> bool:
    try:
        conn = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


def _pkg_manager() -> str:
    if shutil.which('dnf'):
        return 'dnf'
    if shutil.which('yum'):
        return 'yum'
    if shutil.which('apt-get'):
        return 'apt-get'
    return ''


def _find_binary(candidates) -> Optional[str]:
    for name in candidates:
        path = shutil.which(name)
        if path:
            return name
    return None


async def _run_cmd(cmd: str, timeout: float = 120.0) -> tuple:
    """Run shell command, return (returncode, stdout, stderr)."""
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'}
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, stdout.decode('utf-8', errors='replace'), stderr.decode('utf-8', errors='replace')
    except asyncio.TimeoutError:
        return -1, '', 'Timeout'
    except Exception as e:
        return -1, '', str(e)


def _install_cmd_for(backend_key: str) -> str:
    pkg_mgr = _pkg_manager()
    info = BACKENDS.get(backend_key)
    if not info or not pkg_mgr:
        return ''
    pkgs = info['install_pkgs'].get(pkg_mgr)
    if not pkgs:
        return ''
    return f"sudo {pkg_mgr} install -y {' '.join(pkgs)}"


def detect_system_package_manager() -> str:
    pkg = _pkg_manager()
    if pkg in ('dnf', 'yum'):
        return f'sudo {pkg} install -y tigervnc-server xorg-x11-server-Xvfb xterm'
    if pkg == 'apt-get':
        return 'sudo apt update && sudo apt install -y tigervnc-standalone-server xvfb xterm'
    return 'Install tigervnc-server xorg-x11-server-Xvfb xterm via your package manager'


# ────────────────────────────────────────────────────────────────────────────
# Backend status & management
# ────────────────────────────────────────────────────────────────────────────

async def get_backends_status() -> Dict[str, Any]:
    """Return installation and running status for all VNC backends."""
    global _active_backend, _active_backend_port

    result = {}
    for key, info in BACKENDS.items():
        candidates = info['binary_candidates'] or info['binaries']
        found_bin = _find_binary(candidates)
        installed = found_bin is not None
        # x11vnc needs both x11vnc AND Xvfb present
        if info['kind'] == 'x11vnc':
            installed = bool(shutil.which('x11vnc')) and bool(shutil.which('Xvfb'))

        port = info['port']
        listening = await check_tcp_port('127.0.0.1', port)
        install_cmd = _install_cmd_for(key)

        result[key] = {
            'key': key,
            'label': info['label'],
            'description': info['description'],
            'installed': installed,
            'installedBinary': found_bin,
            'port': port,
            'listening': listening,
            'isActive': _active_backend == key,
            'installCmd': install_cmd,
        }

    return {
        'success': True,
        'activeBackend': _active_backend,
        'activePort': _active_backend_port,
        'backends': result,
    }


async def install_backend(backend_key: str = 'x11vnc', server_id: Optional[str] = None) -> Dict[str, Any]:
    """Install system packages for the given VNC backend (local or remote)."""
    if server_id and server_id != 'local-master':
        try:
            import server as master_server
            res, code = await master_server.proxy_to_agent(server_id, '/api/vnc/action', method='POST', json_body={'action': 'install'})
            if code == 200 and isinstance(res, dict) and res.get('success'):
                return {'success': True, 'message': 'x11vnc install finished on remote server.'}
            install_cmd = "if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq x11vnc xvfb; elif command -v dnf >/dev/null; then dnf install -y -q x11vnc xorg-x11-server-Xvfb; fi"
            await master_server.proxy_to_agent(server_id, '/api/terminal/exec', method='POST', json_body={'command': install_cmd})
            return {'success': True, 'message': 'x11vnc package installation command dispatched to remote server.'}
        except Exception as e:
            return {'success': False, 'error': f'Remote install failed: {e}'}

    if backend_key == 'auto':
        backend_key = AUTO_ORDER[0]
    if backend_key not in BACKENDS:
        return {'success': False, 'error': f'Unknown backend: {backend_key}'}

    pkg_mgr = _pkg_manager()
    if not pkg_mgr:
        return {'success': False, 'error': 'No supported package manager found (dnf/yum/apt-get). Please install manually.'}

    pkgs = BACKENDS[backend_key]['install_pkgs'].get(pkg_mgr)
    if not pkgs:
        return {'success': False, 'error': f'No package mapping known for {pkg_mgr}.'}

    cmd = f'{pkg_mgr} install -y {" ".join(pkgs)}'
    print(f'[VNC Install] Running: {cmd}')
    rc, stdout, stderr = await _run_cmd(cmd, timeout=300.0)
    output = (stdout + stderr).strip()[-3000:]

    if rc == 0:
        return {'success': True, 'message': f'Successfully installed: {" ".join(pkgs)}', 'output': output}
    return {'success': False, 'error': f'Install failed (exit {rc})', 'output': output}


async def _kill_vnc_daemons():
    """Kill Xvfb and VNC daemon processes we started."""
    global _xvfb_proc, _vnc_daemon_proc, _active_backend

    for proc in [_vnc_daemon_proc, _xvfb_proc]:
        if proc is not None:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    _xvfb_proc = None
    _vnc_daemon_proc = None
    _active_backend = 'none'

    # Fallback: kill by name in case processes were detached (-bg / -fg &)
    await _run_cmd('pkill -9 -f "Xvnc :99" 2>/dev/null; true', timeout=5)
    await _run_cmd('pkill -9 -f "Xvfb :99" 2>/dev/null; true', timeout=5)
    await _run_cmd('pkill -9 -f "x11vnc.*590" 2>/dev/null; true', timeout=5)
    await _run_cmd('pkill -9 -f "Xtigervnc :99" 2>/dev/null; true', timeout=5)
    await _run_cmd('pkill -9 -f "openbox" 2>/dev/null; true', timeout=5)
    await _run_cmd('vncserver -kill :99 2>/dev/null; true', timeout=5)
    await _run_cmd('tightvncserver -kill :99 2>/dev/null; true', timeout=5)
    # Remove stale X11 lock files for display :99
    await _run_cmd('rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null; true', timeout=5)


async def stop_vnc_backend(backend: str = '', server_id: Optional[str] = None) -> Dict[str, Any]:
    """Stop the running VNC backend (local or remote)."""
    if server_id and server_id != 'local-master':
        try:
            import server as master_server
            res, code = await master_server.proxy_to_agent(server_id, '/api/vnc/action', method='POST', json_body={'action': 'stop'})
            if code == 200 and isinstance(res, dict) and res.get('success'):
                return {'success': True, 'message': 'x11vnc stopped on remote server.'}
            await master_server.proxy_to_agent(server_id, '/api/terminal/exec', method='POST', json_body={'command': 'systemctl stop pulseops-x11vnc; pkill -9 -f x11vnc'})
            return {'success': True, 'message': 'x11vnc stop command sent to remote server.'}
        except Exception as e:
            return {'success': False, 'error': f'Remote stop failed: {e}'}

    global _active_backend

    target = backend or _active_backend
    await _kill_vnc_daemons()
    label = BACKENDS.get(target, {}).get('label', target or 'VNC backend')
    return {'success': True, 'message': f'{label} stopped.'}


# ────────────────────────────────────────────────────────────────────────────
# Backend launchers
# ────────────────────────────────────────────────────────────────────────────

async def _launch_xvnc(backend_key: str, port: int, geometry: str = '1280x800') -> Dict[str, Any]:
    """Launch an Xvnc-family server (TigerVNC or TightVNC).
    Starts a real, self-contained X server + window manager + xterm,
    fully reachable over RFB via WebSockets or native RealVNC / TightVNC viewers.
    """
    global _active_backend, _active_backend_port, _active_display, _vnc_daemon_proc

    info = BACKENDS[backend_key]
    vnc_bin = _find_binary(info['binary_candidates'])
    if not vnc_bin:
        return {
            'success': False,
            'error': f'{info["label"]} is not installed.',
            'installCmd': _install_cmd_for(backend_key),
        }

    # Kill any existing session on :99 first
    await _kill_vnc_daemons()
    await asyncio.sleep(0.8)

    home = os.path.expanduser('~')
    vnc_dir = os.path.join(home, '.vnc')
    os.makedirs(vnc_dir, exist_ok=True)

    # Clean xstartup script: run window manager (openbox / xfce) and xterm.
    # Note: we explicitly do NOT source /etc/X11/xinit/xinitrc because on RHEL/Rocky
    # it executes failsafe Xclients and exits immediately if twm is missing.
    xstartup = os.path.join(vnc_dir, 'xstartup')
    with open(xstartup, 'w') as f:
        f.write('#!/bin/sh\n')
        f.write('unset SESSION_MANAGER\n')
        f.write('unset DBUS_SESSION_BUS_ADDRESS\n')
        f.write('export XDG_SESSION_TYPE=x11\n')
        f.write('if which openbox >/dev/null 2>&1; then\n')
        f.write('    openbox &\n')
        f.write('elif which xfce4-session >/dev/null 2>&1; then\n')
        f.write('    startxfce4 &\n')
        f.write('fi\n')
        f.write('if which xterm >/dev/null 2>&1; then\n')
        f.write('    xterm -geometry 120x35+50+50 -fa "Monospace" -fs 10 -title "PulseOps Terminal" &\n')
        f.write('fi\n')
        f.write('while true; do sleep 60; done\n')
    os.chmod(xstartup, 0o755)

    cfg_path = os.path.join(vnc_dir, 'config')
    with open(cfg_path, 'w') as f:
        f.write(f'geometry={geometry}\n')
        f.write('depth=24\n')
        f.write('SecurityTypes=None\n')

    # Prefer direct Xvnc execution if available (modern TigerVNC on RHEL/Rocky/Debian)
    xvnc_bin = shutil.which('Xvnc')
    output = ''
    if xvnc_bin:
        cmd = f'{xvnc_bin} :99 -geometry {geometry} -depth 24 -rfbport {port} -SecurityTypes None -localhost=0'
        print(f'[VNC {backend_key}] Launching direct Xvnc: {cmd}')
        _vnc_daemon_proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        await asyncio.sleep(1.5)

        # Launch Openbox WM and xterm on DISPLAY :99
        wm_cmd = (
            'DISPLAY=:99 bash -c "'
            'if which openbox >/dev/null 2>&1; then openbox & fi; '
            'if which xterm >/dev/null 2>&1; then xterm -geometry 120x35+50+50 -fa \\"Monospace\\" -fs 10 -title \\"PulseOps Terminal\\" & fi"'
        )
        await asyncio.create_subprocess_shell(wm_cmd)
        await asyncio.sleep(1.0)
    else:
        # Fallback to wrapper script (e.g. tightvncserver)
        cmd = (
            f'{vnc_bin} :99 '
            f'-geometry {geometry} '
            f'-depth 24 '
            f'-SecurityTypes None '
            f'-rfbport {port} '
            f'-localhost no '
            f'-fg &'
        )
        print(f'[VNC {backend_key}] Launching: {cmd}')
        rc, stdout, stderr = await _run_cmd(cmd, timeout=15)
        output = (stdout + stderr).strip()
        await asyncio.sleep(2.0)

    listening = await check_tcp_port('127.0.0.1', port)

    if listening:
        _active_backend = backend_key
        _active_backend_port = port
        _active_display = ':99'
        return {
            'success': True,
            'backend': backend_key,
            'port': port,
            'display': ':99',
            'message': f'{info["label"]} running on :99 -> port {port}. Connect via web or RealVNC / TightVNC Viewer.',
            'output': output,
        }
    return {
        'success': False,
        'backend': backend_key,
        'error': f'{info["label"]} started but port {port} is not listening.',
        'output': output,
        'hint': 'Check that xterm and openbox are installed.',
    }


async def launch_backend_tigervnc(port: int = 5901, geometry: str = '1280x800') -> Dict[str, Any]:
    return await _launch_xvnc('tigervnc', port, geometry)


async def launch_backend_tightvnc(port: int = 5903, geometry: str = '1280x800') -> Dict[str, Any]:
    return await _launch_xvnc('tightvnc', port, geometry)


async def launch_backend_x11vnc(port: int = 5900, geometry: str = '1280x800') -> Dict[str, Any]:
    """Launch x11vnc to expose local desktop or virtual Xvfb display over RFB."""
    global _xvfb_proc, _vnc_daemon_proc, _active_backend, _active_backend_port, _active_display

    if not shutil.which('x11vnc'):
        return {
            'success': False,
            'error': 'x11vnc not found.',
            'installCmd': _install_cmd_for('x11vnc'),
        }

    await _kill_vnc_daemons()
    await asyncio.sleep(0.5)

    # Check if an existing X display is running on :0
    rc_disp, _, _ = await _run_cmd('test -e /tmp/.X11-unix/X0 || pgrep -f "Xorg|Xwayland|X :0"', timeout=2)
    display_to_use = ':0' if rc_disp == 0 else ':99'

    if display_to_use == ':99':
        if not shutil.which('Xvfb'):
            return {
                'success': False,
                'error': 'No physical display :0 found and Xvfb is not installed.',
                'installCmd': _install_cmd_for('x11vnc'),
            }
        width, height = (geometry.split('x') + ['800'])[:2]
        xvfb_cmd = f'Xvfb :99 -screen 0 {width}x{height}x24 -ac +extension GLX +render -noreset'
        print(f'[VNC x11vnc] Starting Xvfb: {xvfb_cmd}')
        _xvfb_proc = await asyncio.create_subprocess_shell(
            xvfb_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        await asyncio.sleep(1.5)

        # Start openbox and xterm on DISPLAY :99
        await _run_cmd(
            'DISPLAY=:99 bash -c "'
            'if which openbox >/dev/null 2>&1; then openbox & fi; '
            'xterm -geometry 120x35+50+50 -fa \\"Monospace\\" -fs 10 -title \\"PulseOps Terminal\\" &"',
            timeout=3
        )
        await asyncio.sleep(0.5)

    log_file = f'/tmp/x11vnc_{port}.log'
    auth_flag = '-auth guess' if display_to_use == ':0' else ''
    x11_cmd = (
        f'x11vnc -display {display_to_use} {auth_flag} '
        f'-rfbport {port} '
        f'-shared -forever -nopw '
        f'-noxdamage -repeat '
        f'-bg -o {log_file}'
    )
    print(f'[VNC x11vnc] Starting: {x11_cmd}')
    _vnc_daemon_proc = await asyncio.create_subprocess_shell(
        x11_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    await asyncio.sleep(2.0)

    listening = await check_tcp_port('127.0.0.1', port)
    if listening:
        _active_backend = 'x11vnc'
        _active_backend_port = port
        _active_display = display_to_use
        return {
            'success': True,
            'backend': 'x11vnc',
            'port': port,
            'display': display_to_use,
            'message': f'x11vnc started on {display_to_use} -> port {port}. Desktop ready for connection.',
        }
    try:
        with open(log_file, 'r') as lf:
            log_tail = lf.read()[-600:]
    except Exception:
        log_tail = 'Log unavailable'
    return {
        'success': False,
        'backend': 'x11vnc',
        'error': f'x11vnc did not bind port {port}.',
        'output': log_tail,
    }


# ────────────────────────────────────────────────────────────────────────────
# Main dispatcher
# ────────────────────────────────────────────────────────────────────────────

_LAUNCHERS = {
    'tigervnc': launch_backend_tigervnc,
    'tightvnc': launch_backend_tightvnc,
    'x11vnc': launch_backend_x11vnc,
}


async def launch_vnc(
    display: str = ':0',
    port: int = 0,
    use_native: bool = False,   # kept for backward-compat API payloads; ignored
    backend: str = 'auto',
    geometry: str = '1280x800',
    server_id: Optional[str] = None
) -> Dict[str, Any]:
    """Main VNC launch dispatcher supporting both local and remote nodes."""
    if server_id and server_id != 'local-master':
        try:
            import server as master_server
            res, code = await master_server.proxy_to_agent(server_id, '/api/vnc/action', method='POST', json_body={'action': 'start'})
            if code == 200 and isinstance(res, dict) and res.get('success'):
                return {'success': True, 'message': 'x11vnc started on remote node.', 'port': 5900, 'server_id': server_id}
            # Fallback via terminal exec
            cmd = "systemctl restart pulseops-x11vnc 2>/dev/null || /usr/local/bin/pulseops-x11vnc-start &"
            await master_server.proxy_to_agent(server_id, '/api/terminal/exec', method='POST', json_body={'command': cmd})
            return {'success': True, 'message': 'x11vnc start command dispatched to remote node.', 'port': 5900, 'server_id': server_id}
        except Exception as e:
            return {'success': False, 'error': f'Remote VNC launch failed: {e}'}

    backend = (backend or 'auto').lower()
    if backend == 'auto':
        backend = 'x11vnc'

    if backend not in _LAUNCHERS:
        backend = 'x11vnc'
    use_port = port or BACKENDS.get(backend, {}).get('port', 5900)
    return await _LAUNCHERS[backend](port=use_port, geometry=geometry)


async def get_vnc_status(target_host: str = '127.0.0.1', server_id: Optional[str] = None) -> Dict[str, Any]:
    """Status endpoint — returns current VNC state including all backends, supporting remote fleet nodes."""
    if server_id and server_id != 'local-master':
        try:
            import fleet as fleet_module
            srv = await fleet_module.get_server(server_id)
            if srv:
                remote_ip = srv.get('host_ip', target_host)
                hostname = srv.get('hostname') or srv.get('display_name') or remote_ip
                open_ports = []
                for p in [5900, 5901, 5902, 5903]:
                    if await check_tcp_port(remote_ip, p):
                        open_ports.append(p)

                agent_data = {}
                try:
                    import server as master_server
                    res, code = await master_server.proxy_to_agent(server_id, '/api/vnc/status')
                    if code == 200 and isinstance(res, dict) and res.get('success'):
                        agent_data = res
                except Exception:
                    pass

                running = len(open_ports) > 0 or agent_data.get('listening', False)
                default_port = open_ports[0] if open_ports else 5900
                display = agent_data.get('display', ':0')
                installed = agent_data.get('installed', True if running else False)

                return {
                    'success': True,
                    'server_id': server_id,
                    'hostname': hostname,
                    'host': remote_ip,
                    'running': running,
                    'openPorts': open_ports,
                    'defaultPort': default_port,
                    'display': display,
                    'activeBackend': 'x11vnc',
                    'activePort': default_port,
                    'isRemote': True,
                    'service_active': agent_data.get('service_active', running),
                    'installed': installed,
                    'backends': {
                        'x11vnc': {
                            'key': 'x11vnc',
                            'label': 'x11vnc Desktop Server',
                            'description': 'Real screen mirror & desktop via x11vnc on port 5900.',
                            'installed': installed,
                            'port': default_port,
                            'listening': running,
                            'isActive': running,
                            'installCmd': 'sudo apt-get install -y x11vnc xvfb'
                        }
                    },
                    'installCmd': 'sudo apt-get install -y x11vnc xvfb'
                }
        except Exception as e:
            print(f"[VNC Remote Status] Error resolving {server_id}: {e}")

    # Local master status
    backends_info = await get_backends_status()

    open_ports = []
    for p in [5900, 5901, 5902, 5903, 5904, 5905]:
        if await check_tcp_port(target_host, p):
            open_ports.append(p)

    installed_binaries = [b for b in ['x11vnc', 'vncserver', 'tightvncserver', 'Xvfb', 'xterm']
                          if shutil.which(b)]

    running = len(open_ports) > 0
    default_port = open_ports[0] if open_ports else 5900

    return {
        'success': True,
        'server_id': 'local-master',
        'hostname': 'Local Master',
        'host': target_host,
        'running': running,
        'openPorts': open_ports,
        'defaultPort': default_port,
        'installedBinaries': installed_binaries,
        'display': os.environ.get('DISPLAY', ':0'),
        'activeBackend': _active_backend if _active_backend != 'none' else ('x11vnc' if running else 'none'),
        'activePort': _active_backend_port if running else default_port,
        'isRemote': False,
        'backends': backends_info['backends'],
        'installCmd': detect_system_package_manager(),
    }
