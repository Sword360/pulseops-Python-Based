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
from typing import Set, Dict, Any, Optional, List
import subprocess
import re

import telemetry
import services
import processes
import terminal
import vnc

# Enterprise modules (optional — degrade gracefully if dependencies missing)
try:
    import database
    import auth
    import users as users_module
    import fleet as fleet_module
    import alerts as alerts_module
    import audit
    ENTERPRISE_AVAILABLE = True
except ImportError as _e:
    ENTERPRISE_AVAILABLE = False
    print(f"[Warning] Enterprise modules not available: {_e}")

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", 3500))
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), 'public')

def get_network_ips() -> List[str]:
    ips = []
    try:
        out = subprocess.check_output(["ip", "-4", "addr", "show"], text=True)
        for m in re.finditer(r'inet\s+([0-9.]+)/\d+', out):
            ip = m.group(1)
            if not ip.startswith('127.') and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    if not ips:
        try:
            import socket
            hostname = socket.gethostname()
            for ip in socket.gethostbyname_ex(hostname)[2]:
                if not ip.startswith('127.') and ip not in ips:
                    ips.append(ip)
        except Exception:
            pass
    return ips

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


async def proxy_to_agent(
    server_id: str,
    endpoint: str,
    method: str = 'GET',
    json_body: Optional[Dict[str, Any]] = None,
    query_params: Optional[Dict[str, str]] = None
) -> tuple:
    """Proxy an API request to a remote fleet agent.
    
    Returns (response_dict, http_status_code).
    """
    if not ENTERPRISE_AVAILABLE:
        return {"success": False, "error": "Enterprise fleet not available"}, 400

    srv = await fleet_module.get_server(server_id)
    if not srv:
        return {"success": False, "error": f"Server '{server_id}' not found"}, 404

    host_ip = srv.get("host_ip")
    port = srv.get("agent_port", 3501)
    token = srv.get("agent_token", "")
    hostname = srv.get("hostname") or srv.get("display_name") or host_ip

    try:
        import aiohttp
    except ImportError:
        return {"success": False, "error": "aiohttp not available on master"}, 500

    url = f"http://{host_ip}:{port}{endpoint}"
    req_headers = {"X-Agent-Token": token}

    try:
        timeout = aiohttp.ClientTimeout(total=8)
        async with aiohttp.ClientSession() as session:
            if method.upper() == 'GET':
                async with session.get(url, params=query_params, headers=req_headers, timeout=timeout) as resp:
                    if resp.status == 404:
                        return {
                            "success": False,
                            "need_update": True,
                            "error": f"Agent on {hostname} needs to be upgraded to v2 to enable remote operations.",
                            "hostname": hostname,
                            "server_id": server_id
                        }, 200
                    try:
                        data = await resp.json()
                        return data, resp.status
                    except Exception:
                        txt = await resp.text()
                        return {"success": False, "error": txt}, resp.status
            elif method.upper() == 'POST':
                async with session.post(url, json=json_body or {}, headers=req_headers, timeout=timeout) as resp:
                    if resp.status == 404:
                        return {
                            "success": False,
                            "need_update": True,
                            "error": f"Agent on {hostname} needs to be upgraded to v2 to enable remote operations.",
                            "hostname": hostname,
                            "server_id": server_id
                        }, 200
                    try:
                        data = await resp.json()
                        return data, resp.status
                    except Exception:
                        txt = await resp.text()
                        return {"success": False, "error": txt}, resp.status
            else:
                return {"success": False, "error": f"Unsupported method {method}"}, 405
    except asyncio.TimeoutError:
        return {"success": False, "error": f"Connection timed out reaching agent on {hostname} ({host_ip}:{port})"}, 504
    except Exception as e:
        return {"success": False, "error": f"Cannot connect to agent on {hostname} ({host_ip}:{port}): {str(e)}"}, 502


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

        # Handle CORS preflight OPTIONS request
        if method == 'OPTIONS':
            cors_hdr = (
                "HTTP/1.1 204 No Content\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
                "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
                "Access-Control-Max-Age: 86400\r\n"
                "\r\n"
            )
            writer.write(cors_hdr.encode('utf-8'))
            await writer.drain()
            writer.close()
            return

        # -------------------------------------------------------------
        # REST API Routes
        # -------------------------------------------------------------
        if path == '/api/services' and method == 'GET':
            target_server = query_params.get('server_id')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/services', 'GET')
                return await send_json_response(writer, res_data, status=code)
            res_data = await services.get_services()
            return await send_json_response(writer, res_data)

        if path == '/api/services/action' and method == 'POST':
            user = await auth.get_current_user(headers.get('authorization', ''))
            if not user or user.get('role') not in ('admin', 'operator'):
                return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot perform service actions.'}, 403)
            target_server = json_body.get('server_id') or query_params.get('server_id')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/services/action', 'POST', json_body=json_body)
                return await send_json_response(writer, res_data, status=code)
            srv_name = json_body.get('serviceName')
            action = json_body.get('action')
            res_data = await services.action_service(srv_name, action)
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if path.startswith('/api/services/') and path.endswith('/logs') and method == 'GET':
            parts_path = path.split('/')
            if len(parts_path) >= 4:
                srv_name = parts_path[3]
                target_server = query_params.get('server_id')
                if target_server and target_server != 'local-master':
                    res_data, code = await proxy_to_agent(target_server, '/api/services/logs', 'GET', query_params={'service': srv_name, 'lines': '100'})
                    return await send_json_response(writer, res_data, status=code)
                res_data = await services.get_service_logs(srv_name)
                return await send_json_response(writer, res_data)

        if path == '/api/processes' and method == 'GET':
            target_server = query_params.get('server_id')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/processes', 'GET')
                return await send_json_response(writer, res_data, status=code)
            res_data = await processes.get_processes()
            return await send_json_response(writer, res_data)

        if path == '/api/processes/kill' and method == 'POST':
            user = await auth.get_current_user(headers.get('authorization', ''))
            if not user or user.get('role') not in ('admin', 'operator'):
                return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot terminate processes.'}, 403)
            target_server = json_body.get('server_id') or query_params.get('server_id')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/processes/kill', 'POST', json_body=json_body)
                return await send_json_response(writer, res_data, status=code)
            pid = json_body.get('pid')
            signal_val = json_body.get('signal', '15')
            res_data = await processes.kill_process(pid, signal_val)
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if path == '/api/terminal/exec' and method == 'POST':
            user = await auth.get_current_user(headers.get('authorization', ''))
            if not user or user.get('role') not in ('admin', 'operator'):
                return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot execute terminal commands.'}, 403)
            target_server = json_body.get('server_id') or query_params.get('server_id')
            command = json_body.get('command')
            sudo_pass = json_body.get('sudoPassword')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/terminal/exec', 'POST', json_body={'command': command})
                return await send_json_response(writer, res_data, status=code)
            res_data = await terminal.exec_terminal_command(command, sudo_pass)
            return await send_json_response(writer, res_data)

        if path == '/api/logs' and method == 'GET':
            target_server = query_params.get('server_id')
            lines_val = query_params.get('lines', '50')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/logs', 'GET', query_params={'lines': lines_val})
                return await send_json_response(writer, res_data, status=code)
            return await send_json_response(writer, {'success': True, 'logs': []})

        if path == '/api/vnc/status' and method == 'GET':
            target_host = query_params.get('host', '127.0.0.1')
            res_data = await vnc.get_vnc_status(target_host)
            return await send_json_response(writer, res_data)

        if path == '/api/vnc/launch' and method == 'POST':
            user = await auth.get_current_user(headers.get('authorization', ''))
            if not user or user.get('role') not in ('admin', 'operator'):
                return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot launch VNC sessions.'}, 403)
            display = json_body.get('display', ':0')
            vnc_port = int(json_body.get('port', 5900))
            use_native = bool(json_body.get('useNative', False))
            res_data = await vnc.launch_vnc(display, vnc_port, use_native)
            return await send_json_response(writer, res_data)

        # Local telemetry snapshot for agent polling
        if path == '/api/telemetry/snapshot' and method == 'GET':
            data = await telemetry.get_full_telemetry()
            mem = data.get('memory', {})
            disks = data.get('disks', [])
            net = data.get('network', {})
            sys_info = data.get('sysInfo', {})
            snapshot = {
                'cpu': data.get('cpu', 0),
                'mem': mem.get('usagePercent', 0),
                'disk': disks[0]['usagePercent'] if disks else 0,
                'rx_sec': net.get('rxSec', 0),
                'tx_sec': net.get('txSec', 0),
                'load1': (sys_info.get('loadAvg') or [0])[0],
                'uptime': sys_info.get('uptime', 0),
                'hostname': sys_info.get('hostname', ''),
                'os_info': sys_info.get('osName', ''),
                'arch': sys_info.get('arch', ''),
            }
            return await send_json_response(writer, snapshot)

        # ── Enterprise API Routes (require ENTERPRISE_AVAILABLE) ─────────────
        if ENTERPRISE_AVAILABLE:

            # ── Auth ─────────────────────────────────────────────────────────
            if path == '/api/auth/login' and method == 'POST':
                email = json_body.get('email', '').strip().lower()
                password = json_body.get('password', '')
                totp_code = json_body.get('totp_code')
                ip = headers.get('x-forwarded-for', 'unknown').split(',')[0].strip()

                if not await auth.check_rate_limit(ip):
                    return await send_json_response(writer, {'detail': 'Too many attempts'}, 429)

                user = await users_module.authenticate_user(email, password)
                if not user:
                    await audit.log_action('auth.login', user_email=email, ip_address=ip, result='failure')
                    return await send_json_response(writer, {'detail': 'Invalid email or password'}, 401)

                if user.get('locked'):
                    return await send_json_response(writer, {'detail': f"Account locked until {user.get('locked_until')}"}, 423)

                if user.get('totp_enabled') and not totp_code:
                    return await send_json_response(writer, {'totp_required': True})

                if user.get('totp_enabled') and totp_code:
                    if not auth.verify_totp(user['totp_secret'], totp_code):
                        return await send_json_response(writer, {'detail': 'Invalid 2FA code'}, 401)

                await auth.reset_failed_login(user['id'])
                access_token = auth.create_access_token(user['id'], user['email'], user['role'])
                refresh_token = auth.create_refresh_token(user['id'])
                await audit.log_action('auth.login', user_id=user['id'], user_email=email, ip_address=ip)
                return await send_json_response(writer, {
                    'access_token': access_token, 'refresh_token': refresh_token,
                    'token_type': 'bearer',
                    'user': {'id': user['id'], 'email': user['email'], 'display_name': user['display_name'], 'role': user['role']}
                })

            if path == '/api/auth/logout' and method == 'POST':
                return await send_json_response(writer, {'success': True})

            if path == '/api/auth/refresh' and method == 'POST':
                rt = json_body.get('refresh_token')
                decoded = auth.decode_token(rt, 'refresh') if rt else None
                if not decoded:
                    return await send_json_response(writer, {'detail': 'Invalid refresh token'}, 401)
                user = await users_module.get_user_by_id(int(decoded['sub']))
                if not user or not user['is_active']:
                    return await send_json_response(writer, {'detail': 'User inactive'}, 401)
                new_token = auth.create_access_token(user['id'], user['email'], user['role'])
                return await send_json_response(writer, {'access_token': new_token, 'token_type': 'bearer'})

            if path == '/api/auth/me' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                u = await users_module.get_user_by_id(user['id'])
                return await send_json_response(writer, u or user)

            # ── User Management (admin only) ──────────────────────────────────
            if path == '/api/admin/users' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                return await send_json_response(writer, await users_module.list_users())

            if path == '/api/admin/users' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                result = await users_module.create_user(
                    email=json_body.get('email', ''),
                    display_name=json_body.get('display_name', ''),
                    password=json_body.get('password', ''),
                    role=json_body.get('role', 'viewer'),
                    created_by=user['id'],
                )
                if not result['success']:
                    return await send_json_response(writer, {'detail': result['error']}, 400)
                await audit.log_action('user.create', user_id=user['id'], user_email=user['email'], resource_type='user', details={'email': json_body.get('email')})
                return await send_json_response(writer, result)

            if path.startswith('/api/admin/users/') and method == 'PUT':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                uid = int(path.split('/')[-1])
                result = await users_module.update_user(uid, json_body, updated_by=user['id'])
                if not result['success']:
                    return await send_json_response(writer, {'detail': result['error']}, 400)
                await audit.log_action('user.update', user_id=user['id'], user_email=user['email'], resource_type='user', resource_id=str(uid))
                return await send_json_response(writer, result)

            if path.startswith('/api/admin/users/') and method == 'DELETE':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                uid = int(path.split('/')[-1])
                result = await users_module.delete_user(uid, user['id'])
                if not result['success']:
                    return await send_json_response(writer, {'detail': result['error']}, 400)
                return await send_json_response(writer, result)

            # ── Fleet Management ──────────────────────────────────────────────
            if path == '/api/fleet/servers' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                q = query_params.get('q')
                group_id = query_params.get('group_id')
                return await send_json_response(writer, await fleet_module.list_servers(search=q, group_id=group_id))

            if path == '/api/fleet/servers' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                result = await fleet_module.register_server(
                    hostname=json_body.get('hostname', ''),
                    host_ip=json_body.get('host_ip', ''),
                    display_name=json_body.get('display_name'),
                    agent_port=int(json_body.get('agent_port', 3500)),
                    tags=json_body.get('tags', []),
                    notes=json_body.get('notes'),
                    added_by=user['id'],
                )
                if not result['success']:
                    return await send_json_response(writer, {'detail': result['error']}, 400)
                await audit.log_action('fleet.server.add', user_id=user['id'], user_email=user['email'], resource_type='server', details={'hostname': json_body.get('hostname')})
                return await send_json_response(writer, result)

            if path.startswith('/api/fleet/servers/') and method == 'GET' and len(path.split('/')) == 5:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                server_id = path.split('/')[4]
                srv = await fleet_module.get_server(server_id)
                if not srv:
                    return await send_json_response(writer, {'detail': 'Server not found'}, 404)
                return await send_json_response(writer, srv)

            if path.startswith('/api/fleet/servers/') and '/metrics' in path and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                parts = path.split('/')
                server_id = parts[4]
                metric = query_params.get('metric', 'cpu_percent')
                range_hours = int(query_params.get('range', 24))
                metrics = await fleet_module.get_server_metrics_history(server_id, metric, range_hours)
                return await send_json_response(writer, {'success': True, 'metrics': metrics})

            if path.startswith('/api/fleet/servers/') and '/snapshots' in path and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                parts = path.split('/')
                server_id = parts[4]
                limit = int(query_params.get('limit', 30))
                snapshots = await fleet_module.get_recent_snapshots(server_id, limit)
                return await send_json_response(writer, {'success': True, 'snapshots': snapshots})

            if path.startswith('/api/fleet/servers/') and method == 'DELETE':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required to remove servers'}, 403)
                server_id = path.split('/')[-1]
                result = await fleet_module.delete_server(server_id)
                if not result['success']:
                    return await send_json_response(writer, {'detail': result.get('error')}, 400)
                await audit.log_action('fleet.server.remove', user_id=user['id'], user_email=user['email'], resource_type='server', resource_id=server_id)
                return await send_json_response(writer, result)

            if path.startswith('/api/fleet/servers/') and method == 'PUT':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required to update servers'}, 403)
                server_id = path.split('/')[-1]
                result = await fleet_module.update_server(server_id, json_body)
                if not result['success']:
                    return await send_json_response(writer, {'detail': result.get('error')}, 400)
                await audit.log_action('fleet.server.update', user_id=user['id'], user_email=user['email'], resource_type='server', resource_id=server_id)
                return await send_json_response(writer, result)

            # ── Agent registration & heartbeat ────────────────────────────────
            if path == '/api/fleet/register' and method == 'POST':
                token = json_body.get('invite_token')
                if not token:
                    return await send_json_response(writer, {'detail': 'invite_token required'}, 400)
                invite = await fleet_module.consume_invite_token(token)
                if not invite:
                    return await send_json_response(writer, {'detail': 'Invalid or expired token'}, 403)
                result = await fleet_module.register_server(
                    hostname=json_body.get('hostname', 'unknown'),
                    host_ip=json_body.get('host_ip', ''),
                    agent_port=int(json_body.get('agent_port', 3501)),
                    os_info=json_body.get('os_info'),
                    arch=json_body.get('arch'),
                    added_by=invite.get('created_by'),
                )
                return await send_json_response(writer, result)

            if path == '/api/fleet/heartbeat' and method == 'POST':
                agent_token = headers.get('x-agent-token') or json_body.get('agent_token', '')
                if not agent_token:
                    return await send_json_response(writer, {'detail': 'X-Agent-Token required'}, 401)
                result = await fleet_module.process_heartbeat(agent_token, json_body)
                if not result['success']:
                    return await send_json_response(writer, {'detail': result.get('error')}, 403)
                return await send_json_response(writer, result)

            # ── Invite tokens ─────────────────────────────────────────────────
            if path == '/api/fleet/invite-tokens' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                expires_hours = int(json_body.get('expires_hours', 24))
                return await send_json_response(writer, await fleet_module.create_invite_token(user['id'], expires_hours))

            if path == '/api/fleet/invite-tokens' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                return await send_json_response(writer, await fleet_module.list_invite_tokens())

            if path.startswith('/api/fleet/invite-tokens/') and method == 'DELETE':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                token_val = path.split('/')[-1]
                await database.execute("DELETE FROM invite_tokens WHERE token = ?", (token_val,))
                return await send_json_response(writer, {'success': True})

            # ── Alert rules ───────────────────────────────────────────────────
            if path == '/api/alerts/rules' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                server_id = query_params.get('server_id')
                return await send_json_response(writer, await alerts_module.list_alert_rules(server_id))

            if path == '/api/alerts/rules' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                result = await alerts_module.create_alert_rule(
                    name=json_body.get('name', ''), metric=json_body.get('metric', 'cpu_percent'),
                    operator=json_body.get('operator', 'gt'), threshold=json_body.get('threshold'),
                    severity=json_body.get('severity', 'warning'), server_id=json_body.get('server_id'),
                    notify_email=json_body.get('notify_email', False), notify_webhook=json_body.get('notify_webhook', False),
                    webhook_url=json_body.get('webhook_url'), created_by=user['id'],
                )
                if not result['success']:
                    return await send_json_response(writer, {'detail': result['error']}, 400)
                return await send_json_response(writer, result)

            if path.startswith('/api/alerts/rules/') and method == 'DELETE':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                try:
                    rule_id = int(path.split('/')[4])
                except (IndexError, ValueError):
                    return await send_json_response(writer, {'detail': 'Invalid rule ID'}, 400)
                result = await alerts_module.delete_alert_rule(rule_id)
                return await send_json_response(writer, result)

            if path == '/api/alerts/active' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                server_id = query_params.get('server_id')
                return await send_json_response(writer, await alerts_module.get_active_alerts(server_id))

            # ── Audit log ─────────────────────────────────────────────────────
            if path == '/api/admin/audit' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                page = int(query_params.get('page', 1))
                page_size = int(query_params.get('page_size', 50))
                result = await audit.get_audit_log(
                    page=page, page_size=page_size,
                    user_filter=query_params.get('user_filter'),
                    action_filter=query_params.get('action_filter'),
                    resource_type_filter=query_params.get('resource_type'),
                    result_filter=query_params.get('result_filter'),
                )
                return await send_json_response(writer, result)

            if path == '/api/admin/audit/recent' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                limit = int(query_params.get('limit', 20))
                return await send_json_response(writer, await audit.get_recent_activity(limit))

            # ── Settings ──────────────────────────────────────────────────────
            if path == '/api/admin/settings' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                rows = await database.fetchall("SELECT key, value FROM settings ORDER BY key ASC")
                result = {}
                for row in rows:
                    result[row['key']] = '••••••••' if 'password' in row['key'] and row['value'] else row['value']
                return await send_json_response(writer, result)

            if path == '/api/admin/settings' and method == 'PUT':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                allowed = {'app_name', 'session_timeout_hours', 'agent_poll_interval', 'snapshot_retention_hours',
                           'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_from',
                           'global_cpu_alert_threshold', 'global_mem_alert_threshold', 'global_disk_alert_threshold', 'master_url'}
                count = 0
                for key, value in json_body.items():
                    if key in allowed:
                        await database.set_setting(key, str(value), user['id'])
                        count += 1
                return await send_json_response(writer, {'success': True, 'updated_count': count})

            # Agent script download
            if path == '/api/fleet/agent-download' and method == 'GET':
                agent_path = os.path.join(os.path.dirname(__file__), 'pulseops_agent.py')
                if os.path.exists(agent_path):
                    with open(agent_path, 'rb') as f:
                        content = f.read()
                    res_hdr = (
                        "HTTP/1.1 200 OK\r\n"
                        "Content-Type: text/plain\r\n"
                        f"Content-Disposition: attachment; filename=pulseops_agent.py\r\n"
                        f"Content-Length: {len(content)}\r\n\r\n"
                    )
                    writer.write(res_hdr.encode() + content)
                    await writer.drain()
                    writer.close()
                    return
                return await send_json_response(writer, {'detail': 'Not found'}, 404)

            # Agent install script
            if path == '/api/fleet/agent-install.sh' and method == 'GET':
                token = query_params.get('token', '')
                host_hdr = headers.get('host', f'localhost:{PORT}')
                proto = 'https' if headers.get('x-forwarded-proto') == 'https' else 'http'
                default_url = f"{proto}://{host_hdr}"
                master_url = await database.get_setting('master_url', default_url)
                if not master_url:
                    master_url = default_url
                script = fleet_module.get_agent_install_script(master_url, token)
                res_hdr = (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: text/x-shellscript\r\n"
                    f"Content-Length: {len(script.encode())}\r\n\r\n"
                )
                writer.write(res_hdr.encode() + script.encode())
                await writer.drain()
                writer.close()
                return

            # Agent update script
            if path == '/api/fleet/agent-update.sh' and method == 'GET':
                host_hdr = headers.get('host', f'localhost:{PORT}')
                proto = 'https' if headers.get('x-forwarded-proto') == 'https' else 'http'
                default_url = f"{proto}://{host_hdr}"
                master_url = await database.get_setting('master_url', default_url)
                if not master_url:
                    master_url = default_url
                script = fleet_module.get_agent_update_script(master_url)
                res_hdr = (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: text/x-shellscript\r\n"
                    f"Content-Length: {len(script.encode())}\r\n\r\n"
                )
                writer.write(res_hdr.encode() + script.encode())
                await writer.drain()
                writer.close()
                return

        # -------------------------------------------------------------
        # /login route — serve login.html
        # -------------------------------------------------------------
        if path in ('/login', '/login.html') and method in ('GET', 'HEAD'):
            login_path = os.path.join(PUBLIC_DIR, 'login.html')
            if os.path.exists(login_path):
                with open(login_path, 'rb') as f:
                    content = f.read()
                res_hdr = (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: text/html; charset=utf-8\r\n"
                    f"Content-Length: {len(content)}\r\n\r\n"
                )
                body = b'' if method == 'HEAD' else content
                writer.write(res_hdr.encode() + body)
                await writer.drain()
                writer.close()
                return

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


HTTP_STATUS_PHRASES = {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    422: "Unprocessable Entity",
    423: "Locked",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
}


async def send_json_response(writer: asyncio.StreamWriter, data: Dict[str, Any], status: int = 200):
    content = json.dumps(data).encode('utf-8')
    status_text = HTTP_STATUS_PHRASES.get(status, "OK" if status < 400 else "Error")
    header = (
        f"HTTP/1.1 {status} {status_text}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(content)}\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
        "\r\n"
    )
    writer.write(header.encode('utf-8') + content)
    await writer.drain()
    writer.close()


# Background task: Telemetry broadcast every 2 seconds
async def telemetry_broadcast_loop():
    while True:
        await asyncio.sleep(2.0)
        try:
            data = await telemetry.get_full_telemetry()
            if ENTERPRISE_AVAILABLE:
                try:
                    fleet_module.update_local_snapshot("local-master", data)
                except Exception:
                    pass
            if connected_ws_clients:
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
    # ── Enterprise initialization ────────────────────────────────────────
    if ENTERPRISE_AVAILABLE:
        try:
            await database.init_db()
            await auth.bootstrap_admin()
            await fleet_module.ensure_local_server(PORT)
            fleet_module.set_broadcast_callback(_fleet_broadcast)
            asyncio.create_task(fleet_module.fleet_health_poll_loop())
            print("✅ Enterprise features initialized (DB, Auth, Fleet)")
        except Exception as e:
            print(f"[Warning] Enterprise init error: {e}")

    server = await asyncio.start_server(handle_http_request, HOST, PORT)
    print(f"\n⚡ PulseOps Enterprise Server running:")
    print(f"   ➜ Local:    http://localhost:{PORT}")
    print(f"   ➜ Login:    http://localhost:{PORT}/login")
    print(f"   ➜ API Docs: http://localhost:{PORT}/api/")
    net_ips = get_network_ips()
    if net_ips:
        for ip in net_ips:
            print(f"   ➜ Network:  http://{ip}:{PORT}")
    elif HOST != "127.0.0.1":
        print(f"   ➜ Network:  http://{HOST}:{PORT}")
    print(f"   ➜ Enterprise features: {'ENABLED' if ENTERPRISE_AVAILABLE else 'DISABLED (install dependencies)'}")
    print()

    asyncio.create_task(telemetry_broadcast_loop())
    asyncio.create_task(log_stream_broadcast_loop())

    async with server:
        await server.serve_forever()


async def _fleet_broadcast(payload: dict) -> None:
    """Broadcast a fleet update to all connected WebSocket clients."""
    msg = json.dumps(payload)
    for ws in list(connected_ws_clients):
        if ws.open and not ws.is_vnc:
            asyncio.create_task(ws.send_text(msg))

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nPulseOps Python Server stopped.")
