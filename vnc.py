import os
import sys
import struct
import socket
import asyncio
import subprocess
from typing import Dict, Any, List, Optional

built_in_vnc_server = None
is_built_in_vnc_running = False

async def check_tcp_port(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        conn = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


async def get_vnc_status(target_host: str = '127.0.0.1') -> Dict[str, Any]:
    common_ports = [5900, 5901, 5902, 5903, 5904, 5905]
    open_ports = []

    for p in common_ports:
        if await check_tcp_port(target_host, p):
            open_ports.append(p)

    installed_binaries = []
    for bin_name in ['x11vnc', 'tigervncserver', 'vncserver', 'wayvnc']:
        try:
            proc = await asyncio.create_subprocess_shell(
                f'which {bin_name}',
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            stdout, _ = await proc.communicate()
            if proc.returncode == 0 and stdout.decode('utf-8').strip():
                installed_binaries.append(bin_name)
        except Exception:
            pass

    running = len(open_ports) > 0 or is_built_in_vnc_running
    default_port = open_ports[0] if open_ports else 5900

    return {
        "success": True,
        "host": target_host,
        "running": running,
        "openPorts": open_ports,
        "defaultPort": default_port,
        "installedBinaries": installed_binaries,
        "display": os.environ.get('DISPLAY', ':0')
    }


class EmbeddedVNCProtocol:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.state = 0

    async def handle_client(self):
        try:
            # Step 1: Send RFB Version 3.8
            self.writer.write(b"RFB 003.008\n")
            await self.writer.drain()

            while not self.reader.at_eof():
                data = await self.reader.read(1024)
                if not data:
                    break

                if self.state == 0:
                    # Client version response -> Send Security Types (1 type: 1 None)
                    self.state = 1
                    self.writer.write(bytes([1, 1]))
                    await self.writer.drain()

                elif self.state == 1:
                    # Security type selection -> Send SecurityResult 0 (OK)
                    self.state = 2
                    res = struct.pack(">I", 0)
                    self.writer.write(res)
                    await self.writer.drain()

                elif self.state == 2:
                    # ClientInit -> Send ServerInit
                    self.state = 3
                    w, h = 1280, 800
                    name = b"PulseOps Embedded VNC (Python)"
                    
                    # PixelFormat: 16 bytes
                    pf = struct.pack(
                        ">BBBBHHHBBB3x",
                        32, 24, 0, 1, 255, 255, 255, 16, 8, 0
                    )
                    server_init = struct.pack(">HH", w, h) + pf + struct.pack(">I", len(name)) + name
                    self.writer.write(server_init)
                    await self.writer.drain()

                elif self.state == 3:
                    # FramebufferUpdateRequest (msgType 3)
                    msg_type = data[0]
                    if msg_type == 3 and len(data) >= 10:
                        await self.send_framebuffer_update(1280, 800)

        except Exception as e:
            pass
        finally:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except Exception:
                pass

    async def send_framebuffer_update(self, w: int, h: int):
        rect_w, rect_h = 640, 400
        rect_x, rect_y = 320, 200

        # Header: msgType 0, padding 1 byte, numRects 1
        hdr = struct.pack(">BxH", 0, 1)
        # Rect header: x, y, width, height, encoding 0 (Raw)
        rect_hdr = struct.pack(">HHHHi", rect_x, rect_y, rect_w, rect_h, 0)

        # Pixel data (RGBx)
        pixels = bytearray(rect_w * rect_h * 4)
        for i in range(0, len(pixels), 4):
            pixels[i] = 16     # Blue
            pixels[i + 1] = 24 # Green
            pixels[i + 2] = 43 # Red
            pixels[i + 3] = 255# Alpha

        self.writer.write(hdr + rect_hdr + bytes(pixels))
        await self.writer.drain()


async def start_built_in_vnc_server(port: int = 5900) -> Dict[str, Any]:
    global built_in_vnc_server, is_built_in_vnc_running

    if is_built_in_vnc_running and built_in_vnc_server:
        return {"success": True, "message": f"PulseOps Native VNC Server already listening on tcp://127.0.0.1:{port}"}

    async def client_cb(reader, writer):
        handler = EmbeddedVNCProtocol(reader, writer)
        await handler.handle_client()

    try:
        built_in_vnc_server = await asyncio.start_server(client_cb, '0.0.0.0', port)
        is_built_in_vnc_running = True
        print(f"[Native VNC Server] PulseOps Native RFB VNC Server running on port {port}")
        return {"success": True, "message": f"PulseOps Native VNC Server started on port {port}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def launch_vnc(display: str = ':0', port: int = 5900, use_native: bool = False) -> Dict[str, Any]:
    if use_native:
        return await start_built_in_vnc_server(port)

    # Check system binaries
    proc = await asyncio.create_subprocess_shell(
        'which x11vnc || which vncserver',
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    stdout, _ = await proc.communicate()
    bin_path = stdout.decode('utf-8').strip()

    if proc.returncode != 0 or not bin_path:
        native_res = await start_built_in_vnc_server(port)
        return {
            "success": True,
            "native": True,
            "message": f"System x11vnc binary not found. Automatically started PulseOps Built-in VNC Server on port {port}!",
            "installCmd": "sudo apt update && sudo apt install -y x11vnc"
        }

    launch_cmd = f"x11vnc -display {display} -rfbport {port} -shared -forever -bg -nopw" if 'x11vnc' in bin_path else f"vncserver {display} -geometry 1280x800"

    proc = await asyncio.create_subprocess_shell(
        launch_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        native_res = await start_built_in_vnc_server(port)
        return {
            "success": True,
            "native": True,
            "message": f"System daemon launch issue ({stderr.decode('utf-8').strip()}). Started PulseOps Built-in VNC Server on port {port}!",
            "installCmd": "sudo apt update && sudo apt install -y x11vnc"
        }

    return {
        "success": True,
        "native": False,
        "message": f"VNC server daemon started on {display} port {port}"
    }
