import os
import struct
import asyncio
import subprocess
from typing import Dict, Any

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

            buffer = bytearray()
            while not self.reader.at_eof():
                chunk = await self.reader.read(4096)
                if not chunk:
                    break
                buffer.extend(chunk)

                # Drain buffer across all protocol states
                while True:
                    if self.state == 0:
                        # Client version response: 12 bytes
                        if len(buffer) < 12:
                            break
                        buffer = buffer[12:]
                        self.state = 1
                        # Send Security Types (1 type: 1 None)
                        self.writer.write(bytes([1, 1]))
                        await self.writer.drain()

                    elif self.state == 1:
                        # Security type selection: 1 byte
                        if len(buffer) < 1:
                            break
                        buffer = buffer[1:]
                        self.state = 2
                        # Send SecurityResult 0 (OK)
                        res = struct.pack(">I", 0)
                        self.writer.write(res)
                        await self.writer.drain()

                    elif self.state == 2:
                        # ClientInit: 1 byte
                        if len(buffer) < 1:
                            break
                        buffer = buffer[1:]
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
                        # Parse client messages in stream
                        while len(buffer) > 0:
                            msg_type = buffer[0]
                            if msg_type == 0:
                                # SetPixelFormat: 20 bytes
                                if len(buffer) < 20:
                                    break
                                buffer = buffer[20:]
                            elif msg_type == 2:
                                # SetEncodings: 4 + 4*numEncodings bytes
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
                                await self.send_framebuffer_update(1280, 800)
                            elif msg_type == 4:
                                # KeyEvent: 8 bytes
                                if len(buffer) < 8:
                                    break
                                buffer = buffer[8:]
                            elif msg_type == 5:
                                # PointerEvent: 6 bytes
                                if len(buffer) < 6:
                                    break
                                buffer = buffer[6:]
                            elif msg_type == 6:
                                # ClientCutText: 8 + len bytes
                                if len(buffer) < 8:
                                    break
                                txt_len = struct.unpack(">I", buffer[4:8])[0]
                                total_len = 8 + txt_len
                                if len(buffer) < total_len:
                                    break
                                buffer = buffer[total_len:]
                            else:
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
            pixels[i] = 16      # Blue
            pixels[i + 1] = 24  # Green
            pixels[i + 2] = 43  # Red
            pixels[i + 3] = 255  # Alpha

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
        await start_built_in_vnc_server(port)
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
        await start_built_in_vnc_server(port)
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
