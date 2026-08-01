import os
import sys
import json
import asyncio
import hashlib
import base64
import struct
import random
import mimetypes
import urllib.parse
from datetime import datetime
from typing import Set, Dict, Any, Optional

import telemetry
import services
import processes
import terminal
import vnc

PORT = int(os.environ.get("PORT", 3500))
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), 'public')

# Set of active WebSocket connections
connected_ws_clients: Set['WebSocketConnection'] = set()

GUID_WS = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

class WebSocketConnection:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, is_vnc: bool = False, query: Dict[str, Any] = None):
        self.reader = reader
        self.writer = writer
        self.is_vnc = is_vnc
        self.query = query or {}
        self.open = True
        self.tcp_proxy_writer: Optional[asyncio.StreamWriter] = None

    async def send_text(self, text: str):
        if not self.open:
            return
        data = text.encode('utf-8')
        await self.send_frame(data, opcode=0x1)

    async def send_bytes(self, data: bytes):
        if not self.open:
            return
        await self.send_frame(data, opcode=0x2)

    async def send_frame(self, payload: bytes, opcode: int = 0x1):
        try:
            length = len(payload)
            hdr = bytearray()
            hdr.append(0x80 | (opcode & 0x0F))  # FIN bit + Opcode

            if length <= 125:
                hdr.append(length)
            elif length <= 65535:
                hdr.append(126)
                hdr.extend(struct.pack('>H', length))
            else:
                hdr.append(127)
                hdr.extend(struct.pack('>Q', length))

            self.writer.write(bytes(hdr) + payload)
            await self.writer.drain()
        except Exception:
            self.open = False

    async def close(self):
        if self.open:
            self.open = False
            try:
                hdr = bytes([0x88, 0x00])  # Close frame
                self.writer.write(hdr)
                await self.writer.drain()
                self.writer.close()
                await self.writer.wait_closed()
            except Exception:
                pass


async def parse_ws_frames(ws: WebSocketConnection):
    try:
        while ws.open and not ws.reader.at_eof():
            head = await ws.reader.readexactly(2)
            fin = (head[0] & 0x80) != 0
            opcode = head[0] & 0x0F
            masked = (head[1] & 0x80) != 0
            length = head[1] & 0x7F

            if opcode == 0x8:  # Close
                ws.open = False
                break
            if opcode == 0x9:  # Ping
                pong_hdr = bytes([0x8A, 0x00])
                ws.writer.write(pong_hdr)
                await ws.writer.drain()
                continue

            if length == 126:
                length_bytes = await ws.reader.readexactly(2)
                length = struct.unpack('>H', length_bytes)[0]
            elif length == 127:
                length_bytes = await ws.reader.readexactly(8)
                length = struct.unpack('>Q', length_bytes)[0]

            mask_key = b''
            if masked:
                mask_key = await ws.reader.readexactly(4)

            payload = await ws.reader.readexactly(length)
            if masked:
                unmasked = bytearray(length)
                for i in range(length):
                    unmasked[i] = payload[i] ^ mask_key[i % 4]
                payload = bytes(unmasked)

            # Handle WebSocket payload
            if ws.is_vnc and ws.tcp_proxy_writer:
                if not ws.tcp_proxy_writer.is_closing():
                    ws.tcp_proxy_writer.write(payload)
                    await ws.tcp_proxy_writer.drain()
            else:
                # Normal WS message (e.g. telemetry ping)
                pass

    except (asyncio.IncompleteReadError, ConnectionResetError, Exception):
        pass
    finally:
        ws.open = False
        if ws in connected_ws_clients:
            connected_ws_clients.remove(ws)


async def handle_vnc_proxy(ws: WebSocketConnection):
    target_host = ws.query.get('host', '127.0.0.1')
    try:
        target_port = int(ws.query.get('port', 5900))
    except ValueError:
        target_port = 5900

    print(f"[VNC Proxy] Initiating connection to RFB server at {target_host}:{target_port}")
    try:
        reader, writer = await asyncio.open_connection(target_host, target_port)
        ws.tcp_proxy_writer = writer
        print(f"[VNC Proxy] TCP Connection established to VNC server {target_host}:{target_port}")

        await ws.send_text(json.dumps({
            "type": "vnc_proxy_meta",
            "status": "connected",
            "host": target_host,
            "port": target_port
        }))

        # Task to forward TCP -> WS
        async def forward_tcp_to_ws():
            try:
                while ws.open and not reader.at_eof():
                    chunk = await reader.read(4096)
                    if not chunk:
                        break
                    await ws.send_bytes(chunk)
            except Exception:
                pass
            finally:
                writer.close()
                await ws.close()

        asyncio.create_task(forward_tcp_to_ws())
        await parse_ws_frames(ws)

    except Exception as e:
        print(f"[VNC Proxy] TCP Error ({target_host}:{target_port}): {e}")
        await ws.send_text(json.dumps({
            "type": "vnc_proxy_meta",
            "status": "error",
            "error": f"VNC Target Error: {e}"
        }))
        await ws.close()


async def handle_http_request(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        request_line = await reader.readline()
        if not request_line:
            writer.close()
            return

        line_str = request_line.decode('utf-8', errors='ignore').strip()
        parts = line_str.split(' ')
        if len(parts) < 2:
            writer.close()
            return

        method, full_path = parts[0], parts[1]
        parsed_url = urllib.parse.urlparse(full_path)
        path = parsed_url.path
        query_params = dict(urllib.parse.parse_qsl(parsed_url.query))

        headers = {}
        content_length = 0
        while True:
            hline = await reader.readline()
            if not hline or hline in (b'\r\n', b'\n'):
                break
            h_str = hline.decode('utf-8', errors='ignore').strip()
            if ':' in h_str:
                hk, hv = h_str.split(':', 1)
                headers[hk.strip().lower()] = hv.strip()
                if hk.strip().lower() == 'content-length':
                    try:
                        content_length = int(hv.strip())
                    except ValueError:
                        content_length = 0

        # WebSocket upgrade request check
        if headers.get('upgrade', '').lower() == 'websocket':
            ws_key = headers.get('sec-websocket-key', '')
            accept_val = base64.b64encode(hashlib.sha1((ws_key + GUID_WS).encode('utf-8')).digest()).decode('utf-8')

            response_headers = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept_val}\r\n\r\n"
            )
            writer.write(response_headers.encode('utf-8'))
            await writer.drain()

            is_vnc = (path == '/api/vnc/ws' or path == '/vnc')
            ws = WebSocketConnection(reader, writer, is_vnc=is_vnc, query=query_params)

            if is_vnc:
                await handle_vnc_proxy(ws)
            else:
                connected_ws_clients.add(ws)
                print("Client connected to PulseOps WebSocket telemetry stream.")
                initial_telemetry = await telemetry.get_full_telemetry()
                await ws.send_text(json.dumps({"type": "telemetry", "data": initial_telemetry}))
                await parse_ws_frames(ws)
            return

        # Read JSON body for POST requests
        body_data = b''
        if content_length > 0:
            body_data = await reader.readexactly(content_length)

        json_body = {}
        if body_data and 'application/json' in headers.get('content-type', ''):
            try:
                json_body = json.loads(body_data.decode('utf-8'))
            except Exception:
                json_body = {}

        # -------------------------------------------------------------
        # REST API Routes
        # -------------------------------------------------------------
        if path == '/api/services' and method == 'GET':
            res_data = await services.get_services()
            return await send_json_response(writer, res_data)

        if path == '/api/services/action' and method == 'POST':
            srv_name = json_body.get('serviceName')
            action = json_body.get('action')
            res_data = await services.action_service(srv_name, action)
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if path.startswith('/api/services/') and path.endswith('/logs') and method == 'GET':
            parts_path = path.split('/')
            if len(parts_path) >= 4:
                srv_name = parts_path[3]
                res_data = await services.get_service_logs(srv_name)
                return await send_json_response(writer, res_data)

        if path == '/api/processes' and method == 'GET':
            res_data = await processes.get_processes()
            return await send_json_response(writer, res_data)

        if path == '/api/processes/kill' and method == 'POST':
            pid = json_body.get('pid')
            signal_val = json_body.get('signal', '15')
            res_data = await processes.kill_process(pid, signal_val)
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if path == '/api/terminal/exec' and method == 'POST':
            command = json_body.get('command')
            sudo_pass = json_body.get('sudoPassword')
            res_data = await terminal.exec_terminal_command(command, sudo_pass)
            return await send_json_response(writer, res_data)

        if path == '/api/vnc/status' and method == 'GET':
            target_host = query_params.get('host', '127.0.0.1')
            res_data = await vnc.get_vnc_status(target_host)
            return await send_json_response(writer, res_data)

        if path == '/api/vnc/launch' and method == 'POST':
            display = json_body.get('display', ':0')
            vnc_port = int(json_body.get('port', 5900))
            use_native = bool(json_body.get('useNative', False))
            res_data = await vnc.launch_vnc(display, vnc_port, use_native)
            return await send_json_response(writer, res_data)

        # -------------------------------------------------------------
        # Static File Serving (from public/)
        # -------------------------------------------------------------
        clean_path = path.lstrip('/')
        if not clean_path:
            clean_path = 'index.html'

        file_path = os.path.normpath(os.path.join(PUBLIC_DIR, clean_path))

        # Security check: ensure path stays inside PUBLIC_DIR
        if os.path.commonpath([file_path, PUBLIC_DIR]) == PUBLIC_DIR and os.path.isfile(file_path):
            mime_type, _ = mimetypes.guess_type(file_path)
            mime_type = mime_type or 'application/octet-stream'

            with open(file_path, 'rb') as f:
                content = f.read()

            res_hdr = (
                "HTTP/1.1 200 OK\r\n"
                f"Content-Type: {mime_type}\r\n"
                f"Content-Length: {len(content)}\r\n"
                "Cache-Control: no-cache\r\n"
                "\r\n"
            )
            writer.write(res_hdr.encode('utf-8') + content)
            await writer.drain()
            writer.close()
            return

        # 404 Not Found
        res_404 = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nNot Found"
        writer.write(res_404.encode('utf-8'))
        await writer.drain()
        writer.close()

    except Exception as e:
        try:
            err_res = f"HTTP/1.1 500 Internal Server Error\r\nContent-Length: {len(str(e))}\r\n\r\n{e}"
            writer.write(err_res.encode('utf-8'))
            await writer.drain()
            writer.close()
        except Exception:
            pass


async def send_json_response(writer: asyncio.StreamWriter, data: Dict[str, Any], status: int = 200):
    content = json.dumps(data).encode('utf-8')
    status_text = "OK" if status == 200 else "Bad Request"
    header = (
        f"HTTP/1.1 {status} {status_text}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(content)}\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "\r\n"
    )
    writer.write(header.encode('utf-8') + content)
    await writer.drain()
    writer.close()


# Background task: Telemetry broadcast every 2 seconds
async def telemetry_broadcast_loop():
    while True:
        await asyncio.sleep(2.0)
        if connected_ws_clients:
            try:
                data = await telemetry.get_full_telemetry()
                payload = json.dumps({"type": "telemetry", "data": data})
                for ws in list(connected_ws_clients):
                    if ws.open and not ws.is_vnc:
                        asyncio.create_task(ws.send_text(payload))
            except Exception as e:
                print(f"Error in telemetry loop: {e}")


# Background task: System log stream broadcast every 3 seconds
async def log_stream_broadcast_loop():
    log_levels = ['INFO', 'DEBUG', 'WARN', 'ERROR']
    log_sources = ['kernel', 'systemd-journald', 'sshd', 'nginx', 'dockerd', 'cron']
    sample_messages = [
        'Connection accepted from 192.168.1.105:49210',
        'DHCP lease renewed on interface eth0',
        'Periodic cron job /usr/bin/certbot executed successfully',
        'GET /api/v1/telemetry 200 OK - 12ms',
        'Memory page cache flushed',
        'SSL handshake completed for host admin.pulseops.local',
        'CPU frequency scaled to peak governor mode',
        'Disk I/O flush completed in 4.2ms'
    ]

    while True:
        await asyncio.sleep(3.0)
        if connected_ws_clients:
            try:
                log_entry = {
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                    "level": random.choice(log_levels),
                    "source": random.choice(log_sources),
                    "message": random.choice(sample_messages)
                }
                payload = json.dumps({"type": "logStream", "data": log_entry})
                for ws in list(connected_ws_clients):
                    if ws.open and not ws.is_vnc:
                        asyncio.create_task(ws.send_text(payload))
            except Exception as e:
                print(f"Error in log stream loop: {e}")


async def main():
    server = await asyncio.start_server(handle_http_request, '0.0.0.0', PORT)
    print(f"PulseOps Python Server listening on http://localhost:{PORT}")

    asyncio.create_task(telemetry_broadcast_loop())
    asyncio.create_task(log_stream_broadcast_loop())

    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nPulseOps Python Server stopped.")
