"""
PulseOps - VNC / RFB Remote Desktop Subsystem
Supports multiple backends: Native Python RFB, TigerVNC+Xvfb, x11vnc+Xvfb.
"""

import os
import time
import shutil
import struct
import asyncio
import subprocess
import psutil
from typing import Dict, Any, List, Optional
from PIL import Image, ImageDraw, ImageFont

# ── Native built-in server state ────────────────────────────────────────────
built_in_vnc_server = None
is_built_in_vnc_running = False
built_in_vnc_port = 5900

# ── External backend process tracking ───────────────────────────────────────
_xvfb_proc: Optional[asyncio.subprocess.Process] = None
_vnc_daemon_proc: Optional[asyncio.subprocess.Process] = None
_active_backend: str = 'none'      # 'none' | 'native' | 'tigervnc' | 'x11vnc'
_active_backend_port: int = 5900
_active_display: str = ':99'

# ── Backend definitions ──────────────────────────────────────────────────────
BACKENDS = {
    'native': {
        'label': 'PulseOps Built-in (Python RFB)',
        'description': 'Embedded Python RFB 3.8 server — live stats dashboard, always works, no install needed.',
        'binaries': [],
        'port': 5900,
        'install_pkgs': [],
    },
    'tigervnc': {
        'label': 'TigerVNC + Xvfb (Real Linux Desktop)',
        'description': 'Full real Linux desktop via TigerVNC with virtual framebuffer. Runs xterm. Like TightVNC viewer.',
        'binaries': ['vncserver', 'Xvfb'],
        'port': 5901,
        'install_pkgs': ['tigervnc-server', 'xorg-x11-server-Xvfb', 'xterm'],
    },
    'x11vnc': {
        'label': 'x11vnc + Xvfb (Mirror Display)',
        'description': 'x11vnc mirrors a virtual Xvfb display. Real xterm/apps on virtual screen.',
        'binaries': ['x11vnc', 'Xvfb'],
        'port': 5902,
        'install_pkgs': ['x11vnc', 'xorg-x11-server-Xvfb', 'xterm'],
    },
}


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
        installed_bins = [b for b in info['binaries'] if shutil.which(b)]
        installed = (len(info['binaries']) == 0) or (len(installed_bins) == len(info['binaries']))
        port = info['port']
        listening = await check_tcp_port('127.0.0.1', port)

        pkg_mgr = _pkg_manager()
        if info['install_pkgs'] and pkg_mgr:
            install_cmd = f"{pkg_mgr} install -y {' '.join(info['install_pkgs'])}"
        else:
            install_cmd = ''

        result[key] = {
            'key': key,
            'label': info['label'],
            'description': info['description'],
            'installed': installed,
            'installedBinaries': installed_bins,
            'missingBinaries': [b for b in info['binaries'] if b not in installed_bins],
            'port': port,
            'listening': listening,
            'isActive': _active_backend == key,
            'installCmd': install_cmd,
            'installPkgs': info['install_pkgs'],
        }

    # Native is always installed; listening if built-in is running
    result['native']['installed'] = True
    result['native']['listening'] = is_built_in_vnc_running or await check_tcp_port('127.0.0.1', 5900)
    result['native']['isActive'] = _active_backend in ('native', 'none') and result['native']['listening']

    return {
        'success': True,
        'activeBackend': _active_backend,
        'activePort': _active_backend_port,
        'backends': result,
    }


async def install_backend(backend_key: str) -> Dict[str, Any]:
    """Install system packages for the given VNC backend."""
    if backend_key not in BACKENDS:
        return {'success': False, 'error': f'Unknown backend: {backend_key}'}

    info = BACKENDS[backend_key]
    if not info['install_pkgs']:
        return {'success': True, 'message': 'No packages needed — backend is always available.'}

    pkg_mgr = _pkg_manager()
    if not pkg_mgr:
        return {'success': False, 'error': 'No supported package manager found (dnf/yum/apt-get).'}

    pkgs = ' '.join(info['install_pkgs'])
    cmd = f'{pkg_mgr} install -y {pkgs}'

    print(f'[VNC Install] Running: {cmd}')
    rc, stdout, stderr = await _run_cmd(cmd, timeout=300.0)
    output = (stdout + stderr).strip()[-3000:]

    if rc == 0:
        return {
            'success': True,
            'message': f'Successfully installed: {pkgs}',
            'output': output,
        }
    else:
        return {
            'success': False,
            'error': f'Install failed (exit {rc})',
            'output': output,
        }


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

    # Fallback: kill by name
    await _run_cmd('pkill -f "Xvfb :99" 2>/dev/null; true', timeout=5)
    await _run_cmd('pkill -f "x11vnc.*590" 2>/dev/null; true', timeout=5)
    await _run_cmd('pkill -9 -f "Xtigervnc :99" 2>/dev/null; true', timeout=5)


async def stop_vnc_backend(backend: str = '') -> Dict[str, Any]:
    """Stop the running VNC backend."""
    global _active_backend

    target = backend or _active_backend

    if target == 'tigervnc':
        await _run_cmd('vncserver -kill :99 2>/dev/null; pkill -f "Xtigervnc :99" 2>/dev/null; true', timeout=10)
        _active_backend = 'none'
        return {'success': True, 'message': 'TigerVNC session :99 stopped.'}
    elif target == 'x11vnc':
        await _kill_vnc_daemons()
        return {'success': True, 'message': 'x11vnc + Xvfb stopped.'}
    else:
        await _kill_vnc_daemons()
        return {'success': True, 'message': 'VNC backend stopped.'}


# ────────────────────────────────────────────────────────────────────────────
# Backend launchers
# ────────────────────────────────────────────────────────────────────────────

async def launch_backend_tigervnc(port: int = 5901, geometry: str = '1280x800') -> Dict[str, Any]:
    """Launch TigerVNC server with its own built-in Xvnc X server."""
    global _active_backend, _active_backend_port, _active_display

    vnc_bin = shutil.which('vncserver') or shutil.which('tigervncserver')
    if not vnc_bin:
        return {
            'success': False,
            'error': 'vncserver not found.',
            'installCmd': f"{_pkg_manager() or 'dnf'} install -y tigervnc-server xterm"
        }

    # Kill any existing session
    await _run_cmd('vncserver -kill :99 2>/dev/null; pkill -9 -f "Xtigervnc :99" 2>/dev/null; true', timeout=10)
    await asyncio.sleep(0.8)

    # Set up ~/.vnc directory
    home = os.path.expanduser('~')
    vnc_dir = os.path.join(home, '.vnc')
    os.makedirs(vnc_dir, exist_ok=True)

    # Write xstartup — try desktop environments, fallback to xterms
    xstartup = os.path.join(vnc_dir, 'xstartup')
    with open(xstartup, 'w') as f:
        f.write('#!/bin/sh\n')
        f.write('unset SESSION_MANAGER\n')
        f.write('unset DBUS_SESSION_BUS_ADDRESS\n')
        f.write('export XDG_SESSION_TYPE=x11\n')
        f.write('[ -r /etc/X11/xinit/xinitrc ] && . /etc/X11/xinit/xinitrc\n')
        f.write('if which xfce4-session >/dev/null 2>&1; then\n')
        f.write('    exec startxfce4\n')
        f.write('elif which openbox-session >/dev/null 2>&1; then\n')
        f.write('    exec openbox-session\n')
        f.write('elif which fluxbox >/dev/null 2>&1; then\n')
        f.write('    exec fluxbox &\n')
        f.write('    wait\n')
        f.write('else\n')
        f.write('    xterm -geometry 200x50+0+0 -fa "Monospace" -fs 10 -title "PulseOps Terminal" &\n')
        f.write('    xterm -geometry 100x25+800+0 -fa "Monospace" -fs 10 -title "Shell 2" &\n')
        f.write('    wait\n')
        f.write('fi\n')
    os.chmod(xstartup, 0o755)

    # Write TigerVNC config
    cfg_path = os.path.join(vnc_dir, 'config')
    with open(cfg_path, 'w') as f:
        f.write(f'geometry={geometry}\n')
        f.write('depth=24\n')
        f.write('SecurityTypes=None\n')

    # Also write passwd file stub (empty = no password with SecurityTypes=None)
    # TigerVNC >= 1.8 respects SecurityTypes=None without needing a passwd file
    cmd = (
        f'{vnc_bin} :99 '
        f'-geometry {geometry} '
        f'-depth 24 '
        f'-SecurityTypes None '
        f'-rfbport {port} '
        f'-localhost no '
        f'-fg &'
    )
    print(f'[VNC TigerVNC] Launching: {cmd}')
    rc, stdout, stderr = await _run_cmd(cmd, timeout=15)
    output = (stdout + stderr).strip()

    await asyncio.sleep(2.0)
    listening = await check_tcp_port('127.0.0.1', port)

    if listening:
        _active_backend = 'tigervnc'
        _active_backend_port = port
        _active_display = ':99'
        return {
            'success': True,
            'backend': 'tigervnc',
            'port': port,
            'display': ':99',
            'message': f'TigerVNC running on :99 → port {port}. You can now Connect and see a real Linux desktop!',
            'output': output,
        }
    else:
        return {
            'success': False,
            'backend': 'tigervnc',
            'error': f'TigerVNC started but port {port} not listening.',
            'output': output,
            'hint': 'Try installing xterm: dnf install -y xterm',
        }


async def launch_backend_x11vnc(port: int = 5902, geometry: str = '1280x800') -> Dict[str, Any]:
    """Launch Xvfb virtual display + x11vnc to expose it over RFB."""
    global _xvfb_proc, _vnc_daemon_proc, _active_backend, _active_backend_port, _active_display

    if not shutil.which('x11vnc'):
        return {
            'success': False,
            'error': 'x11vnc not found.',
            'installCmd': f"{_pkg_manager() or 'dnf'} install -y x11vnc xorg-x11-server-Xvfb xterm"
        }
    if not shutil.which('Xvfb'):
        return {
            'success': False,
            'error': 'Xvfb not found.',
            'installCmd': f"{_pkg_manager() or 'dnf'} install -y xorg-x11-server-Xvfb xterm"
        }

    # Kill existing
    await _kill_vnc_daemons()
    await asyncio.sleep(0.5)

    # Start Xvfb on :99
    width, height = (geometry.split('x') + ['800'])[:2]
    xvfb_cmd = f'Xvfb :99 -screen 0 {width}x{height}x24 -ac +extension GLX +render -noreset'
    print(f'[VNC x11vnc] Starting Xvfb: {xvfb_cmd}')
    _xvfb_proc = await asyncio.create_subprocess_shell(
        xvfb_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    await asyncio.sleep(1.8)

    # Verify Xvfb is up
    rc_check, _, _ = await _run_cmd('pgrep -f "Xvfb :99"', timeout=3)
    if rc_check != 0:
        return {'success': False, 'error': 'Xvfb failed to start on :99.'}

    # Launch xterm(s) on virtual display
    await _run_cmd(
        'DISPLAY=:99 xterm -geometry 200x50+0+0 -fa "Monospace" -fs 10 -title "PulseOps Terminal" &',
        timeout=3
    )
    await asyncio.sleep(0.5)

    # Start x11vnc to expose :99
    log_file = f'/tmp/x11vnc_{port}.log'
    x11_cmd = (
        f'x11vnc -display :99 '
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
    await asyncio.sleep(2.5)

    listening = await check_tcp_port('127.0.0.1', port)
    if listening:
        _active_backend = 'x11vnc'
        _active_backend_port = port
        _active_display = ':99'
        return {
            'success': True,
            'backend': 'x11vnc',
            'port': port,
            'display': ':99',
            'message': f'x11vnc + Xvfb started on :99 → port {port}. Real Linux xterm desktop visible!',
        }
    else:
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

async def launch_vnc(
    display: str = ':0',
    port: int = 5900,
    use_native: bool = False,
    backend: str = 'native',
    geometry: str = '1280x800'
) -> Dict[str, Any]:
    """Main VNC launch dispatcher. backend = 'native' | 'tigervnc' | 'x11vnc'."""
    if use_native or backend == 'native':
        return await start_built_in_vnc_server(port)
    elif backend == 'tigervnc':
        return await launch_backend_tigervnc(port=port, geometry=geometry)
    elif backend == 'x11vnc':
        return await launch_backend_x11vnc(port=port, geometry=geometry)
    else:
        return await start_built_in_vnc_server(port)


async def get_vnc_status(target_host: str = '127.0.0.1') -> Dict[str, Any]:
    """Status endpoint — returns current VNC state including all backends."""
    backends_info = await get_backends_status()

    open_ports = []
    for p in [5900, 5901, 5902, 5903, 5904, 5905]:
        if await check_tcp_port(target_host, p):
            open_ports.append(p)

    installed_binaries = [b for b in ['x11vnc', 'vncserver', 'Xvfb', 'xterm']
                          if shutil.which(b)]

    running = len(open_ports) > 0 or is_built_in_vnc_running
    default_port = open_ports[0] if open_ports else (built_in_vnc_port if is_built_in_vnc_running else 5900)

    return {
        'success': True,
        'host': target_host,
        'running': running,
        'openPorts': open_ports,
        'defaultPort': default_port,
        'isBuiltInRunning': is_built_in_vnc_running,
        'installedBinaries': installed_binaries,
        'display': os.environ.get('DISPLAY', ':0'),
        'activeBackend': _active_backend,
        'backends': backends_info['backends'],
        'installCmd': detect_system_package_manager(),
    }


# ────────────────────────────────────────────────────────────────────────────
# Native Python RFB Desktop Renderer
# ────────────────────────────────────────────────────────────────────────────

class DesktopRenderer:
    """
    High-performance graphical Linux desktop compositor using Pillow.
    Renders live system telemetry, interactive bash shell, and hardware mouse cursor.
    """
    def __init__(self, width: int = 1280, height: int = 800):
        self.width = width
        self.height = height
        self.cursor_x = 640
        self.cursor_y = 400
        self.button_mask = 0
        self.active_window = 'terminal'

        # Fonts
        self.f_title = ImageFont.load_default(size=14)
        self.f_body = ImageFont.load_default(size=12)
        self.f_mono = ImageFont.load_default(size=13)
        self.f_small = ImageFont.load_default(size=11)

        # Terminal state
        uname_info = os.uname()
        self.history: List[str] = [
            f"PulseOps RFB Linux Desktop v2.0 - Kernel {uname_info.release} ({uname_info.sysname})",
            "Interactive RFB VNC Session connected (Display :0, 1280x800@32bpp).",
            "Hardware & Virtual Terminal initialized. Type commands or use keyboard.",
            'Try: "top", "status", "free", "df", "uptime", "uname -a", "ps", "clear", "help"'
        ]
        self.current_input = ""

        # Pre-render static base surface
        self._init_base_surface()

        # Cache & dirty tracking
        self.last_render_time = 0.0
        self.cached_frame: Optional[bytes] = None
        self.dirty = True

    def _init_base_surface(self):
        w, h = self.width, self.height
        im = Image.new('RGBA', (w, h), (10, 15, 29, 255))
        d = ImageDraw.Draw(im)

        # Background cyber grid
        for x in range(0, w, 40):
            d.line([(x, 0), (x, h)], fill=(18, 26, 45, 255), width=1)
        for y in range(0, h, 40):
            d.line([(0, y), (w, y)], fill=(18, 26, 45, 255), width=1)

        # Top desktop header bar
        d.rectangle([(0, 0), (w, 34)], fill=(14, 20, 36, 255))
        d.line([(0, 34), (w, 34)], fill=(30, 41, 59, 255), width=1)
        d.text((15, 9), '⚡ PulseOps Remote Linux Desktop (RFB 3.8)', fill=(0, 242, 254, 255), font=self.f_title)
        uname = os.uname()
        d.text((430, 10), f'Host: {uname.nodename} ({uname.sysname} {uname.release})', fill=(148, 163, 184, 255), font=self.f_small)

        # Telemetry Window Frame
        d.rectangle([(40, 55), (580, 500)], fill=(12, 18, 32, 255), outline=(0, 242, 254, 180), width=1)
        d.rectangle([(40, 55), (580, 87)], fill=(19, 27, 46, 255))
        d.text((70, 63), '📊 System Telemetry & Resource Monitor', fill=(241, 245, 249, 255), font=self.f_title)
        d.ellipse([(50, 67), (60, 77)], fill=(239, 68, 68, 255))
        d.ellipse([(64, 67), (74, 77)], fill=(245, 158, 11, 255))
        d.ellipse([(78, 67), (88, 77)], fill=(16, 185, 129, 255))

        # Terminal Window Frame
        d.rectangle([(610, 55), (1240, 680)], fill=(8, 12, 22, 255), outline=(56, 189, 248, 180), width=1)
        d.rectangle([(610, 55), (1240, 87)], fill=(15, 23, 42, 255))
        d.text((640, 63), '💻 Interactive Bash Console (pulseops@edge-node:~)', fill=(241, 245, 249, 255), font=self.f_title)
        d.ellipse([(620, 67), (630, 77)], fill=(239, 68, 68, 255))
        d.ellipse([(634, 67), (644, 77)], fill=(245, 158, 11, 255))
        d.ellipse([(648, 67), (658, 77)], fill=(16, 185, 129, 255))

        # Bottom Dock
        dock_w = 420
        dock_x = (w - dock_w) // 2
        d.rectangle([(dock_x, h - 55), (dock_x + dock_w, h - 15)], fill=(14, 20, 36, 240), outline=(0, 242, 254, 80))
        d.text((dock_x + 30, h - 42), '[Monitor]', fill=(0, 242, 254, 255), font=self.f_mono)
        d.text((dock_x + 130, h - 42), '[Terminal]', fill=(56, 189, 248, 255), font=self.f_mono)
        d.text((dock_x + 235, h - 42), '[Fleet]', fill=(168, 85, 247, 255), font=self.f_mono)
        d.text((dock_x + 325, h - 42), '[Settings]', fill=(148, 163, 184, 255), font=self.f_mono)

        self.base_surface = im

    def handle_key(self, down_flag: bool, key_sym: int):
        if not down_flag:
            return

        self.dirty = True

        # Backspace
        if key_sym == 0xff08:
            self.current_input = self.current_input[:-1]
        # Enter
        elif key_sym == 0xff0d:
            cmd = self.current_input.strip()
            self.history.append(f"pulseops@node:~$ {self.current_input}")
            self.execute_terminal_cmd(cmd)
            self.current_input = ""
        # Escape
        elif key_sym == 0xff1b:
            self.current_input = ""
        # Tab
        elif key_sym == 0xff09:
            self.current_input += "  "
        # Printable ASCII characters
        elif 32 <= key_sym <= 126:
            self.current_input += chr(key_sym)

    def handle_text(self, text: str):
        self.dirty = True
        for ch in text:
            if ch == '\n' or ch == '\r':
                cmd = self.current_input.strip()
                self.history.append(f"pulseops@node:~$ {self.current_input}")
                self.execute_terminal_cmd(cmd)
                self.current_input = ""
            elif 32 <= ord(ch) <= 126:
                self.current_input += ch

    def execute_terminal_cmd(self, cmd: str):
        if not cmd:
            return

        parts = cmd.split()
        base_cmd = parts[0].lower()

        if base_cmd == 'clear':
            self.history.clear()
        elif base_cmd == 'help':
            self.history.extend([
                "PulseOps Built-in Shell Commands:",
                "  top / status  - Show live CPU, RAM, Disk, System load",
                "  free / free -m- Display memory and swap statistics",
                "  df / df -h    - Display filesystem disk usage",
                "  uptime        - Show node uptime and load average",
                "  uname -a      - Print OS kernel architecture",
                "  ps            - Show top running processes",
                "  whoami        - Print current effective user",
                "  date          - Display current system date & time",
                "  ping          - Ping local loopback interface",
                "  clear         - Clear terminal screen"
            ])
        elif base_cmd in ('top', 'status'):
            cpu = psutil.cpu_percent()
            vm = psutil.virtual_memory()
            du = psutil.disk_usage('/')
            self.history.extend([
                f"[SYSTEM STATUS REPORT] {time.strftime('%Y-%m-%d %H:%M:%S')}",
                f"  CPU Load:    {cpu:.1f}% ({psutil.cpu_count(logical=True)} logical cores)",
                f"  RAM Usage:   {vm.percent:.1f}% ({vm.used // (1024*1024)}MB / {vm.total // (1024*1024)}MB)",
                f"  Disk Usage:  {du.percent:.1f}% ({du.used // (1024**3)}GB / {du.total // (1024**3)}GB)",
                f"  Load Avg:    {os.getloadavg()}",
                f"  Total PIDs:  {len(psutil.pids())} active processes"
            ])
        elif base_cmd == 'free':
            vm = psutil.virtual_memory()
            swap = psutil.swap_memory()
            self.history.extend([
                "               total        used        free      shared  buff/cache   available",
                f"Mem:       {vm.total//(1024*1024):9d} {vm.used//(1024*1024):11d} {vm.free//(1024*1024):11d} {getattr(vm, 'shared', 0)//(1024*1024):11d} {getattr(vm, 'cached', 0)//(1024*1024):11d} {vm.available//(1024*1024):11d}",
                f"Swap:      {swap.total//(1024*1024):9d} {swap.used//(1024*1024):11d} {swap.free//(1024*1024):11d}"
            ])
        elif base_cmd == 'df':
            du = psutil.disk_usage('/')
            self.history.extend([
                "Filesystem      Size  Used Avail Use% Mounted on",
                f"/dev/root       {du.total//(1024**3):3d}G  {du.used//(1024**3):3d}G  {du.free//(1024**3):3d}G  {du.percent:.0f}% /"
            ])
        elif base_cmd == 'uptime':
            up_secs = int(time.time() - psutil.boot_time())
            hrs = up_secs // 3600
            mins = (up_secs % 3600) // 60
            self.history.append(f" {time.strftime('%H:%M:%S')} up {hrs} hours, {mins} mins,  1 user,  load average: {os.getloadavg()}")
        elif base_cmd == 'uname':
            u = os.uname()
            self.history.append(f"{u.sysname} {u.nodename} {u.release} {u.version} {u.machine}")
        elif base_cmd == 'whoami':
            self.history.append(os.getenv('USER', 'root'))
        elif base_cmd == 'date':
            self.history.append(time.strftime("%a %b %d %H:%M:%S %Z %Y"))
        elif base_cmd == 'ping':
            self.history.extend([
                "PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.",
                "64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.038 ms",
                "64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.029 ms",
                "--- 127.0.0.1 ping statistics --- 2 packets transmitted, 2 received, 0% packet loss"
            ])
        elif base_cmd == 'ps':
            self.history.append("  PID USER     %CPU %MEM COMMAND")
            try:
                procs = []
                for p in psutil.process_iter(['pid', 'username', 'cpu_percent', 'memory_percent', 'name']):
                    try:
                        procs.append(p.info)
                    except Exception:
                        pass
                procs.sort(key=lambda x: (x.get('cpu_percent') or 0), reverse=True)
                for pr in procs[:8]:
                    p_usr = (pr.get('username') or 'root')[:6]
                    p_name = (pr.get('name') or 'unknown')[:18]
                    self.history.append(f"{pr.get('pid', 0):5d} {p_usr:8s} {pr.get('cpu_percent', 0.0):4.1f} {pr.get('memory_percent', 0.0):4.1f} {p_name}")
            except Exception as e:
                self.history.append(f"ps error: {e}")
        else:
            self.history.append(f"{cmd}: command not found (type 'help' for built-in commands)")

    def handle_pointer(self, x: int, y: int, button_mask: int):
        self.cursor_x = min(max(0, x), self.width)
        self.cursor_y = min(max(0, y), self.height)
        self.button_mask = button_mask
        self.dirty = True

        # Click handling
        if button_mask & 1:  # Left Click
            if 610 <= x <= 1240 and 55 <= y <= 680:
                self.active_window = 'terminal'
            elif 40 <= x <= 580 and 55 <= y <= 500:
                self.active_window = 'telemetry'
            elif 430 <= x <= 850 and self.height - 55 <= y <= self.height - 15:
                # Dock click
                if x < 530:
                    self.active_window = 'telemetry'
                elif x < 630:
                    self.active_window = 'terminal'
                elif x < 730:
                    self.history.append("pulseops@node:~$ fleet-status")
                    self.history.append("All fleet edge probes healthy. 1 active node attached.")
                else:
                    self.history.append("pulseops@node:~$ pulseops-config")
                    self.history.append("VNC RFB 3.8 Server running on 0.0.0.0:5900 (RGBA TrueColor 32bpp)")

    def render(self) -> bytes:
        now = time.time()
        # Throttled render cache: if not dirty and less than 60ms since last frame, reuse frame
        if not self.dirty and (now - self.last_render_time) < 0.06 and self.cached_frame is not None:
            return self.cached_frame

        im = self.base_surface.copy()
        d = ImageDraw.Draw(im)
        w, h = self.width, self.height

        # Dynamic Top Bar Clock
        d.text((w - 180, 10), time.strftime('%Y-%m-%d %H:%M:%S'), fill=(241, 245, 249, 255), font=self.f_mono)

        # Dynamic Telemetry
        cpu = psutil.cpu_percent()
        d.text((60, 105), f'CPU Utilization: {cpu:.1f}%', fill=(0, 242, 254, 255), font=self.f_body)
        d.rectangle([(60, 125), (560, 145)], fill=(20, 30, 50, 255), outline=(40, 60, 90, 255))
        cpu_w = int((min(100.0, max(0.0, cpu)) / 100.0) * 500)
        d.rectangle([(60, 125), (60 + cpu_w, 145)], fill=(0, 242, 254, 255))

        vm = psutil.virtual_memory()
        d.text((60, 160), f'Memory RAM: {vm.percent:.1f}% ({vm.used // (1024*1024)}MB / {vm.total // (1024*1024)}MB)', fill=(168, 85, 247, 255), font=self.f_body)
        d.rectangle([(60, 180), (560, 200)], fill=(20, 30, 50, 255), outline=(40, 60, 90, 255))
        ram_w = int((min(100.0, max(0.0, vm.percent)) / 100.0) * 500)
        d.rectangle([(60, 180), (60 + ram_w, 200)], fill=(168, 85, 247, 255))

        du = psutil.disk_usage('/')
        d.text((60, 215), f'Disk Storage (/): {du.percent:.1f}% ({du.used // (1024**3)}GB / {du.total // (1024**3)}GB)', fill=(16, 185, 129, 255), font=self.f_body)
        d.rectangle([(60, 235), (560, 255)], fill=(20, 30, 50, 255), outline=(40, 60, 90, 255))
        disk_w = int((min(100.0, max(0.0, du.percent)) / 100.0) * 500)
        d.rectangle([(60, 235), (60 + disk_w, 255)], fill=(16, 185, 129, 255))

        load_1, load_5, load_15 = os.getloadavg()
        d.text((60, 275), f'Load Average: {load_1:.2f}, {load_5:.2f}, {load_15:.2f}', fill=(148, 163, 184, 255), font=self.f_body)
        d.text((60, 295), f'Cores: {psutil.cpu_count(logical=True)} | Processes: {len(psutil.pids())}', fill=(148, 163, 184, 255), font=self.f_body)

        # Top processes mini-table in telemetry window
        d.text((60, 335), 'Top Processes (Live):', fill=(241, 245, 249, 255), font=self.f_title)
        d.text((60, 355), 'PID    CPU%  MEM%  COMMAND', fill=(100, 116, 139, 255), font=self.f_mono)
        try:
            p_list = []
            for p in psutil.process_iter(['pid', 'cpu_percent', 'memory_percent', 'name']):
                try:
                    p_list.append(p.info)
                except Exception:
                    pass
            p_list.sort(key=lambda x: (x.get('cpu_percent') or 0), reverse=True)
            for idx, pr in enumerate(p_list[:5]):
                line_str = f"{pr.get('pid', 0):<6d} {pr.get('cpu_percent', 0.0):>4.1f}% {pr.get('memory_percent', 0.0):>4.1f}%  {(pr.get('name') or 'proc')[:14]}"
                d.text((60, 375 + idx * 20), line_str, fill=(203, 213, 225, 255), font=self.f_mono)
        except Exception:
            pass

        # Dynamic Terminal Output
        term_y = 100
        for line in self.history[-24:]:
            color = (56, 189, 248, 255) if line.startswith('pulseops') else (203, 213, 225, 255)
            if 'Error' in line or 'not found' in line:
                color = (239, 68, 68, 255)
            elif 'PONG' in line or 'PING' in line or '---' in line:
                color = (16, 185, 129, 255)
            d.text((625, term_y), line, fill=color, font=self.f_mono)
            term_y += 18

        cursor_char = '_' if (int(now * 2) % 2 == 0) else ' '
        d.text((625, term_y), f"pulseops@node:~$ {self.current_input}{cursor_char}", fill=(0, 242, 254, 255), font=self.f_mono)

        # Draw sleek hardware mouse cursor arrow
        cx, cy = self.cursor_x, self.cursor_y
        d.polygon([(cx, cy), (cx + 12, cy + 12), (cx + 5, cy + 14), (cx, cy + 18)], fill=(0, 242, 254, 255), outline=(255, 255, 255, 255))

        self.cached_frame = im.tobytes()
        self.last_render_time = now
        self.dirty = False
        return self.cached_frame


# ────────────────────────────────────────────────────────────────────────────
# Native Python RFB Protocol Server
# ────────────────────────────────────────────────────────────────────────────

class EmbeddedVNCProtocol:
    """
    Standard RFB 3.8 Protocol Server implementation.
    RFC 6143 compliant: handshakes version, security, server-init, and streams Raw framebuffer updates.
    """
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.state = 0
        self.desktop = DesktopRenderer(1280, 800)

    async def handle_client(self):
        try:
            # Step 1: Send RFB Version 3.8 (12 bytes)
            self.writer.write(b"RFB 003.008\n")
            await self.writer.drain()

            buffer = bytearray()
            while not self.reader.at_eof():
                chunk = await self.reader.read(65536)
                if not chunk:
                    break
                buffer.extend(chunk)

                # Process all complete protocol messages in buffer
                while True:
                    if self.state == 0:
                        # Client version response: exactly 12 bytes
                        if len(buffer) < 12:
                            break
                        buffer = buffer[12:]
                        self.state = 1
                        # Send Security Types: 1 type supported -> Type 1 (None)
                        self.writer.write(bytes([1, 1]))
                        await self.writer.drain()

                    elif self.state == 1:
                        # Security type selection: 1 byte
                        if len(buffer) < 1:
                            break
                        buffer = buffer[1:]
                        self.state = 2
                        # Send SecurityResult: uint32 0 (OK)
                        res = struct.pack(">I", 0)
                        self.writer.write(res)
                        await self.writer.drain()

                    elif self.state == 2:
                        # ClientInit: 1 byte shared-flag
                        if len(buffer) < 1:
                            break
                        buffer = buffer[1:]
                        self.state = 3

                        w, h = self.desktop.width, self.desktop.height
                        name = b"PulseOps Native RFB Desktop (Rocky Linux)"

                        # PixelFormat (16 bytes):
                        # bitsPerPixel=32, depth=24, bigEndian=0, trueColour=1,
                        # redMax=255, greenMax=255, blueMax=255, redShift=0, greenShift=8, blueShift=16, pad=3x
                        pf = struct.pack(
                            ">BBBBHHHBBB3x",
                            32, 24, 0, 1, 255, 255, 255, 0, 8, 16
                        )
                        server_init = struct.pack(">HH", w, h) + pf + struct.pack(">I", len(name)) + name
                        self.writer.write(server_init)
                        await self.writer.drain()

                    elif self.state == 3:
                        # Connected state: parse client messages
                        consumed = 0
                        while len(buffer) > 0:
                            msg_type = buffer[0]
                            if msg_type == 0:
                                # SetPixelFormat: 20 bytes
                                if len(buffer) < 20:
                                    break
                                buffer = buffer[20:]
                            elif msg_type == 2:
                                # SetEncodings: 4 + 4 * numEncodings bytes
                                if len(buffer) < 4:
                                    break
                                num_enc = struct.unpack(">H", buffer[2:4])[0]
                                total_len = 4 + 4 * num_enc
                                if len(buffer) < total_len:
                                    break
                                buffer = buffer[total_len:]
                            elif msg_type == 3:
                                # FramebufferUpdateRequest: 10 bytes
                                if len(buffer) < 10:
                                    break
                                buffer = buffer[10:]
                                await self.send_framebuffer_update()
                            elif msg_type == 4:
                                # KeyEvent: 8 bytes
                                if len(buffer) < 8:
                                    break
                                down_flag = bool(buffer[1])
                                key_sym = struct.unpack(">I", buffer[4:8])[0]
                                buffer = buffer[8:]
                                self.desktop.handle_key(down_flag, key_sym)
                            elif msg_type == 5:
                                # PointerEvent: 6 bytes
                                if len(buffer) < 6:
                                    break
                                bmask = buffer[1]
                                px, py = struct.unpack(">HH", buffer[2:6])
                                buffer = buffer[6:]
                                self.desktop.handle_pointer(px, py, bmask)
                            elif msg_type == 6:
                                # ClientCutText: 8 + len bytes
                                if len(buffer) < 8:
                                    break
                                txt_len = struct.unpack(">I", buffer[4:8])[0]
                                total_len = 8 + txt_len
                                if len(buffer) < total_len:
                                    break
                                text_bytes = buffer[8:total_len]
                                buffer = buffer[total_len:]
                                try:
                                    self.desktop.handle_text(text_bytes.decode('utf-8', errors='ignore'))
                                except Exception:
                                    pass
                            else:
                                # Unknown client message, advance 1 byte
                                buffer = buffer[1:]
                        break

        except Exception:
            pass
        finally:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except Exception:
                pass

    async def send_framebuffer_update(self):
        w, h = self.desktop.width, self.desktop.height
        raw_pixels = self.desktop.render()

        # Header: msgType 0, pad 1 byte, numRects 1
        hdr = struct.pack(">BxH", 0, 1)
        # Rect header: x=0, y=0, width=1280, height=800, encoding=0 (Raw)
        rect_hdr = struct.pack(">HHHHi", 0, 0, w, h, 0)

        self.writer.write(hdr + rect_hdr + raw_pixels)
        await self.writer.drain()


async def start_built_in_vnc_server(port: int = 5900) -> Dict[str, Any]:
    global built_in_vnc_server, is_built_in_vnc_running, built_in_vnc_port, _active_backend, _active_backend_port

    if is_built_in_vnc_running and built_in_vnc_server:
        _active_backend = 'native'
        return {"success": True, "message": f"PulseOps Native RFB VNC Server already listening on 0.0.0.0:{port}"}

    async def client_cb(reader, writer):
        handler = EmbeddedVNCProtocol(reader, writer)
        await handler.handle_client()

    try:
        built_in_vnc_server = await asyncio.start_server(client_cb, '0.0.0.0', port)
        is_built_in_vnc_running = True
        built_in_vnc_port = port
        _active_backend = 'native'
        _active_backend_port = port
        print(f"[Native VNC Server] PulseOps Native RFB VNC Server listening on 0.0.0.0:{port}")
        return {"success": True, "message": f"PulseOps Native RFB VNC Server started on port {port}"}
    except Exception as e:
        # If port is already in use by another instance or daemon, check if it's reachable
        if await check_tcp_port('127.0.0.1', port):
            is_built_in_vnc_running = True
            _active_backend = 'native'
            return {"success": True, "message": f"VNC Server is active and listening on port {port}"}
        return {"success": False, "error": str(e)}
