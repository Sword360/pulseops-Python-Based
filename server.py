import os
import json
import asyncio
import hashlib
import base64
import struct
import random
import mimetypes
import urllib.parse
import urllib.request
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from typing import Set, Dict, Any, Optional, List
import subprocess
import re

import telemetry
import services
import processes
import terminal
import vnc
import docker_manager
import ports_manager
import firewall_manager
import security_manager
import commands_manager
import maintenance_manager
import ssl_manager

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
        if ws.is_vnc and ws.tcp_proxy_writer:
            try:
                ws.tcp_proxy_writer.close()
            except Exception:
                pass


async def handle_vnc_proxy(ws: WebSocketConnection):
    server_id = ws.query.get('server_id')
    target_host = ws.query.get('host', '127.0.0.1')
    try:
        target_port = int(ws.query.get('port', 5900))
    except ValueError:
        target_port = 5900

    if server_id and server_id != 'local-master':
        srv = await fleet_module.get_server(server_id)
        if srv:
            target_host = srv.get('host_ip', target_host)

    print(f"[VNC Proxy] Initiating connection to RFB server at {target_host}:{target_port} (server_id={server_id})")
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
                    chunk = await reader.read(65536)
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
                    if resp.status == 401:
                        return {
                            "success": False,
                            "token_mismatch": True,
                            "unauthorized": True,
                            "error": f"Agent token authentication failed on {hostname} (401 Unauthorized). The agent daemon is running with an out-of-sync token. Run 'sudo systemctl restart pulseops-agent' on {hostname}.",
                            "fix_cmd": "sudo systemctl restart pulseops-agent",
                            "hostname": hostname,
                            "server_id": server_id
                        }, 401
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
                    if resp.status == 401:
                        return {
                            "success": False,
                            "token_mismatch": True,
                            "unauthorized": True,
                            "error": f"Agent token authentication failed on {hostname} (401 Unauthorized). The agent daemon is running with an out-of-sync token. Run 'sudo systemctl restart pulseops-agent' on {hostname}.",
                            "fix_cmd": "sudo systemctl restart pulseops-agent",
                            "hostname": hostname,
                            "server_id": server_id
                        }, 401
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
            is_vnc = (path == '/api/vnc/ws' or path == '/vnc')

            if is_vnc and ENTERPRISE_AVAILABLE:
                tok = query_params.get('token', '')
                auth_hdr = headers.get('authorization', '')
                if not auth_hdr and tok:
                    auth_hdr = f'Bearer {tok}'
                user = await auth.get_current_user(auth_hdr)
                if not user or user.get('role') not in ('admin', 'operator'):
                    print(f"[VNC Proxy] Forbidden/Unauthorized WebSocket connection rejected for {user.get('email') if user else 'anonymous'}")
                    detail = "Permission denied: Viewers cannot open VNC sessions" if user else "Unauthorized WebSocket connection"
                    status_line = "HTTP/1.1 403 Forbidden\r\n" if user else "HTTP/1.1 401 Unauthorized\r\n"
                    resp = (
                        f"{status_line}"
                        "Content-Type: application/json\r\n"
                        "Connection: close\r\n\r\n"
                        f'{{"detail":"{detail}"}}'
                    )
                    writer.write(resp.encode('utf-8'))
                    await writer.drain()
                    writer.close()
                    return

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
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/services', 'GET')
                return await send_json_response(writer, res_data, status=code)
            res_data = await services.get_services()
            return await send_json_response(writer, res_data)

        if path == '/api/services/action' and method == 'POST':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot perform service actions.'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            srv_name = json_body.get('serviceName')
            action = json_body.get('action')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/services/action', 'POST', json_body=json_body)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action(
                        f"service.{action}", user_id=user['id'], user_email=user['email'],
                        resource_type="service", resource_id=srv_name,
                        details={"server_id": target_server},
                        result="success" if (isinstance(res_data, dict) and res_data.get('success')) else "failure"
                    )
                return await send_json_response(writer, res_data, status=code)
            res_data = await services.action_service(srv_name, action)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    f"service.{action}", user_id=user['id'], user_email=user['email'],
                    resource_type="service", resource_id=srv_name,
                    result="success" if res_data.get('success') else "failure"
                )
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if (path == '/api/services/logs' or (path.startswith('/api/services/') and path.endswith('/logs'))) and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            if path == '/api/services/logs':
                srv_name = query_params.get('service', '')
            else:
                parts_path = path.split('/')
                srv_name = parts_path[3] if len(parts_path) >= 4 else ''
            target_server = query_params.get('server_id') or query_params.get('serverId')
            lines_val = query_params.get('lines', '100')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/services/logs', 'GET', query_params={'service': srv_name, 'lines': lines_val})
                return await send_json_response(writer, res_data, status=code)
            res_data = await services.get_service_logs(srv_name)
            return await send_json_response(writer, res_data)

        if path == '/api/processes' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/processes', 'GET')
                return await send_json_response(writer, res_data, status=code)
            res_data = await processes.get_processes()
            return await send_json_response(writer, res_data)

        if path == '/api/processes/kill' and method == 'POST':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot terminate processes.'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            pid = json_body.get('pid')
            signal_val = json_body.get('signal', '15')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/processes/kill', 'POST', json_body=json_body)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action(
                        "process.kill", user_id=user['id'], user_email=user['email'],
                        resource_type="process", resource_id=str(pid),
                        details={"signal": signal_val, "server_id": target_server},
                        result="success" if (isinstance(res_data, dict) and res_data.get('success')) else "failure"
                    )
                return await send_json_response(writer, res_data, status=code)
            res_data = await processes.kill_process(pid, signal_val)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    "process.kill", user_id=user['id'], user_email=user['email'],
                    resource_type="process", resource_id=str(pid),
                    details={"signal": signal_val},
                    result="success" if res_data.get('success') else "failure"
                )
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        # ─── Docker Container Management Endpoints ──────────────────
        if path == '/api/docker/status' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/docker/status', 'GET')
                return await send_json_response(writer, res_data, status=code)
            res_data = await docker_manager.is_docker_available()
            return await send_json_response(writer, res_data)

        if path == '/api/docker/containers' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/docker/containers', 'GET')
                return await send_json_response(writer, res_data, status=code)
            all_param = query_params.get('all', 'true').lower() in ('true', '1', 'yes')
            res_data = await docker_manager.get_containers(all_containers=all_param)
            return await send_json_response(writer, res_data)

        if path == '/api/docker/action' and method == 'POST':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot manage containers.'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            cid = json_body.get('container_id') or json_body.get('container') or ''
            action = json_body.get('action') or ''
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/docker/action', 'POST', json_body=json_body)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action(
                        f"docker.{action}", user_id=user['id'], user_email=user['email'],
                        resource_type="container", resource_id=str(cid),
                        details={"server_id": target_server, "action": action},
                        result="success" if (isinstance(res_data, dict) and res_data.get('success')) else "failure"
                    )
                return await send_json_response(writer, res_data, status=code)
            res_data = await docker_manager.action_container(cid, action)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    f"docker.{action}", user_id=user['id'], user_email=user['email'],
                    resource_type="container", resource_id=str(cid),
                    details={"action": action},
                    result="success" if res_data.get('success') else "failure"
                )
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if path == '/api/docker/logs' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            cid = query_params.get('container_id') or query_params.get('container') or ''
            try:
                lines_val = int(query_params.get('lines', '100'))
            except (ValueError, TypeError):
                lines_val = 100
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/docker/logs', 'GET', query_params={'container': cid, 'lines': str(lines_val)})
                return await send_json_response(writer, res_data, status=code)
            res_data = await docker_manager.get_container_logs(cid, lines=lines_val)
            return await send_json_response(writer, res_data)

        if path == '/api/docker/inspect' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            cid = query_params.get('container_id') or query_params.get('container') or ''
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/docker/inspect', 'GET', query_params={'container': cid})
                return await send_json_response(writer, res_data, status=code)
            res_data = await docker_manager.inspect_container(cid)
            return await send_json_response(writer, res_data)

        # ─── Network Listening Ports Endpoints ──────────────────────
        if path == '/api/network/ports' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/network/ports', 'GET')
                return await send_json_response(writer, res_data, status=code)
            res_data = await ports_manager.get_listening_ports()
            return await send_json_response(writer, res_data)

        # ─── Firewall Rules & Security Endpoints ────────────────────
        if path in ('/api/firewall/status', '/api/firewall/rules') and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/firewall/status', 'GET')
                return await send_json_response(writer, res_data, status=code)
            res_data = await firewall_manager.get_firewall_status()
            return await send_json_response(writer, res_data)

        if path in ('/api/firewall/rules', '/api/firewall/rules/add') and method == 'POST':
            client_ip = headers.get('x-forwarded-for', '127.0.0.1').split(',')[0].strip()
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/firewall/rules/add', 'POST', json_body=json_body)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action(
                        'firewall.add_rule', user_id=user['id'], user_email=user['email'],
                        resource_type='firewall', resource_id=str(json_body.get('port', '')), ip_address=client_ip,
                        details={'server_id': target_server, 'rule': json_body},
                        result='success' if (isinstance(res_data, dict) and res_data.get('success')) else 'failure'
                    )
                return await send_json_response(writer, res_data, status=code)
            res_data = await firewall_manager.add_firewall_rule(json_body)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    'firewall.add_rule', user_id=user['id'], user_email=user['email'],
                    resource_type='firewall', resource_id=str(json_body.get('port', '')), ip_address=client_ip,
                    details={'server_id': 'local-master', 'rule': json_body},
                    result='success' if res_data.get('success') else 'failure'
                )
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if path in ('/api/firewall/rules/delete',) and method in ('POST', 'DELETE'):
            client_ip = headers.get('x-forwarded-for', '127.0.0.1').split(',')[0].strip()
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/firewall/rules/delete', 'POST', json_body=json_body)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action(
                        'firewall.delete_rule', user_id=user['id'], user_email=user['email'],
                        resource_type='firewall', resource_id=str(json_body.get('id', '')), ip_address=client_ip,
                        details={'server_id': target_server, 'rule': json_body},
                        result='success' if (isinstance(res_data, dict) and res_data.get('success')) else 'failure'
                    )
                return await send_json_response(writer, res_data, status=code)
            res_data = await firewall_manager.delete_firewall_rule(json_body)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    'firewall.delete_rule', user_id=user['id'], user_email=user['email'],
                    resource_type='firewall', resource_id=str(json_body.get('id', '')), ip_address=client_ip,
                    details={'server_id': 'local-master', 'rule': json_body},
                    result='success' if res_data.get('success') else 'failure'
                )
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if path == '/api/firewall/reload' and method == 'POST':
            client_ip = headers.get('x-forwarded-for', '127.0.0.1').split(',')[0].strip()
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/firewall/reload', 'POST', json_body=json_body)
                return await send_json_response(writer, res_data, status=code)
            res_data = await firewall_manager.reload_firewall()
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    'firewall.reload', user_id=user['id'], user_email=user['email'],
                    resource_type='firewall', resource_id='reload', ip_address=client_ip,
                    details={'server_id': 'local-master'},
                    result='success' if res_data.get('success') else 'failure'
                )
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        # ─── Security & Threat Intelligence Endpoints ───────────────
        if path in ('/api/security/threats', '/api/security/ssh') and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/security/threats', 'GET')
                return await send_json_response(writer, res_data, status=code)
            res_data = await security_manager.get_ssh_threats()
            return await send_json_response(writer, res_data)

        if path == '/api/security/ban' and method == 'POST':
            client_ip = headers.get('x-forwarded-for', '127.0.0.1').split(',')[0].strip()
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            ip_to_ban = str(json_body.get('ip', '')).strip()
            reason = str(json_body.get('reason', 'SSH Brute-Force'))
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/security/ban', 'POST', json_body=json_body)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action(
                        'security.ban_ip', user_id=user['id'], user_email=user['email'],
                        resource_type='security', resource_id=ip_to_ban, ip_address=client_ip,
                        details={'server_id': target_server, 'ip': ip_to_ban, 'reason': reason},
                        result='success' if (isinstance(res_data, dict) and res_data.get('success')) else 'failure'
                    )
                return await send_json_response(writer, res_data, status=code)
            res_data = await security_manager.ban_ip(ip_to_ban, reason)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    'security.ban_ip', user_id=user['id'], user_email=user['email'],
                    resource_type='security', resource_id=ip_to_ban, ip_address=client_ip,
                    details={'server_id': 'local-master', 'ip': ip_to_ban, 'reason': reason},
                    result='success' if res_data.get('success') else 'failure'
                )
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        if path == '/api/security/unban' and method == 'POST':
            client_ip = headers.get('x-forwarded-for', '127.0.0.1').split(',')[0].strip()
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            ip_to_unban = str(json_body.get('ip', '')).strip()
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/security/unban', 'POST', json_body=json_body)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action(
                        'security.unban_ip', user_id=user['id'], user_email=user['email'],
                        resource_type='security', resource_id=ip_to_unban, ip_address=client_ip,
                        details={'server_id': target_server, 'ip': ip_to_unban},
                        result='success' if (isinstance(res_data, dict) and res_data.get('success')) else 'failure'
                    )
                return await send_json_response(writer, res_data, status=code)
            res_data = await security_manager.unban_ip(ip_to_unban)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    'security.unban_ip', user_id=user['id'], user_email=user['email'],
                    resource_type='security', resource_id=ip_to_unban, ip_address=client_ip,
                    details={'server_id': 'local-master', 'ip': ip_to_unban},
                    result='success' if res_data.get('success') else 'failure'
                )
            return await send_json_response(writer, res_data, status=200 if res_data.get('success') else 400)

        # ─── SSL / TLS Certificate Manager Endpoints ─────────────────
        if path == '/api/ssl/certificates' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/ssl/certificates', 'GET')
                return await send_json_response(writer, res_data, status=code)
            certs = ssl_manager.scan_host_certificates()
            return await send_json_response(writer, {'success': True, 'certificates': certs})

        if path == '/api/ssl/monitored' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            domains = ssl_manager.list_monitored_domains()
            return await send_json_response(writer, {'success': True, 'domains': domains})

        if path == '/api/ssl/monitored' and method == 'POST':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            host = json_body.get('host', '').strip()
            port = int(json_body.get('port', 443))
            label = json_body.get('label', '').strip()
            server_id = json_body.get('server_id', 'local-master')
            res = ssl_manager.add_monitored_domain(host, port=port, label=label, server_id=server_id)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action('ssl.domain_add', user_id=user['id'], user_email=user['email'],
                                       resource_type='ssl', details={'host': host, 'port': port})
            return await send_json_response(writer, res, status=200 if res.get('success') else 400)

        if path.startswith('/api/ssl/monitored/') and path.endswith('/refresh') and method == 'POST':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            try:
                dom_id = int(path.split('/')[4])
                res = ssl_manager.refresh_monitored_domain(dom_id)
                return await send_json_response(writer, res, status=200 if res.get('success') else 400)
            except Exception as e:
                return await send_json_response(writer, {'detail': str(e)}, 400)

        if path.startswith('/api/ssl/monitored/') and method == 'DELETE':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            try:
                dom_id = int(path.split('/')[-1])
                ok = ssl_manager.delete_monitored_domain(dom_id)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action('ssl.domain_delete', user_id=user['id'], user_email=user['email'],
                                           resource_type='ssl', resource_id=str(dom_id))
                return await send_json_response(writer, {'success': ok}, status=200 if ok else 404)
            except Exception as e:
                return await send_json_response(writer, {'detail': str(e)}, 400)

        if path == '/api/ssl/probe' and method == 'POST':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = json_body.get('server_id') or json_body.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/ssl/probe', 'POST', json_body=json_body)
                return await send_json_response(writer, res_data, status=code)
            host = json_body.get('host', '').strip()
            port = int(json_body.get('port', 443))
            res = ssl_manager.probe_tls_endpoint(host, port=port)
            return await send_json_response(writer, res, status=200 if res.get('success') else 400)

        if path == '/api/ssl/certbot' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/ssl/certbot', 'GET')
                return await send_json_response(writer, res_data, status=code)
            return await send_json_response(writer, ssl_manager.check_certbot_status())

        # ─── Saved Commands & Runbooks Endpoints ─────────────────────
        if path == '/api/commands' and method == 'GET':
            user_role = 'viewer'
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                user_role = user.get('role', 'viewer')
            cmds = await commands_manager.list_commands(user_role)
            return await send_json_response(writer, {'success': True, 'commands': cmds})

        if path == '/api/commands' and method == 'POST':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            name = json_body.get('name', '')
            desc = json_body.get('description', '')
            cmd_text = json_body.get('command', '')
            req_sudo = bool(json_body.get('requires_sudo', False))
            roles = json_body.get('allowed_roles', ['admin', 'operator'])
            uid = user['id'] if user else 1
            res = await commands_manager.create_command(name, desc, cmd_text, req_sudo, roles, created_by=uid)
            return await send_json_response(writer, res, status=200 if res.get('success') else 400)

        if path.startswith('/api/commands/') and not path.endswith('/execute') and method == 'PUT':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            try:
                cmd_id = int(path.split('/')[-1])
                res = await commands_manager.update_command(
                    cmd_id, json_body.get('name', ''), json_body.get('description', ''),
                    json_body.get('command', ''), bool(json_body.get('requires_sudo', False)),
                    json_body.get('allowed_roles', ['admin', 'operator'])
                )
                return await send_json_response(writer, res, status=200 if res.get('success') else 400)
            except ValueError:
                return await send_json_response(writer, {'detail': 'Invalid command ID'}, 400)

        if path.startswith('/api/commands/') and not path.endswith('/execute') and method == 'DELETE':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            try:
                cmd_id = int(path.split('/')[-1])
                res = await commands_manager.delete_command(cmd_id)
                return await send_json_response(writer, res, status=200 if res.get('success') else 400)
            except ValueError:
                return await send_json_response(writer, {'detail': 'Invalid command ID'}, 400)

        if path.startswith('/api/commands/') and path.endswith('/execute') and method == 'POST':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            try:
                cmd_id = int(path.split('/')[-2])
                cmd_obj = await commands_manager.get_command(cmd_id)
                if not cmd_obj:
                    return await send_json_response(writer, {'detail': 'Command not found'}, 404)
                user_role = user.get('role', 'viewer') if user else 'admin'
                if user_role not in cmd_obj.get('allowed_roles', []) and user_role != 'admin':
                    return await send_json_response(writer, {'detail': 'Role not authorized to run this runbook'}, 403)

                target_server = json_body.get('server_id') or json_body.get('serverId')
                sudo_pass = json_body.get('sudoPassword', '')
                cmd_text = cmd_obj['command']

                # Substitute custom params if provided: {{PARAM_NAME}}
                custom_params = json_body.get('params') or {}
                for k, v in custom_params.items():
                    cmd_text = cmd_text.replace(f"{{{{{k}}}}}", str(v))

                if target_server and target_server != 'local-master':
                    res_data, code = await proxy_to_agent(target_server, '/api/terminal/exec', 'POST', json_body={'command': cmd_text, 'sudoPassword': sudo_pass})
                    if ENTERPRISE_AVAILABLE and user:
                        await audit.log_action("runbook.exec", user_id=user['id'], user_email=user['email'], resource_type="command", resource_id=str(cmd_id), details={"command": cmd_obj['name'], "server_id": target_server})
                    return await send_json_response(writer, res_data, status=code)

                res_data = await terminal.exec_terminal_command(cmd_text, sudo_pass)
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action("runbook.exec", user_id=user['id'], user_email=user['email'], resource_type="command", resource_id=str(cmd_id), details={"command": cmd_obj['name']})
                return await send_json_response(writer, res_data)
            except ValueError:
                return await send_json_response(writer, {'detail': 'Invalid command ID'}, 400)

        # ─── Maintenance Windows & Groups Endpoints ──────────────────
        if path == '/api/maintenance/windows' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            sid = query_params.get('server_id')
            windows = await maintenance_manager.list_maintenance_windows(sid)
            return await send_json_response(writer, {'success': True, 'windows': windows})

        if path == '/api/maintenance/windows' and method == 'POST':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            res = await maintenance_manager.create_maintenance_window(
                json_body.get('server_id', ''), json_body.get('start_time', ''),
                json_body.get('end_time', ''), json_body.get('reason', ''),
                created_by=user['id'] if user else 1
            )
            return await send_json_response(writer, res, status=200 if res.get('success') else 400)

        if path.startswith('/api/maintenance/windows/') and method == 'DELETE':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied'}, 403)
            try:
                wid = int(path.split('/')[-1])
                res = await maintenance_manager.delete_maintenance_window(wid)
                return await send_json_response(writer, res, status=200 if res.get('success') else 400)
            except ValueError:
                return await send_json_response(writer, {'detail': 'Invalid window ID'}, 400)

        if path == '/api/maintenance/groups' and method == 'GET':
            groups = await maintenance_manager.list_server_groups()
            return await send_json_response(writer, {'success': True, 'groups': groups})

        if path == '/api/maintenance/groups' and method == 'POST':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin permission required'}, 403)
            res = await maintenance_manager.create_server_group(
                json_body.get('id', ''), json_body.get('name', ''),
                json_body.get('color', ''), json_body.get('description', '')
            )
            return await send_json_response(writer, res, status=200 if res.get('success') else 400)

        if path.startswith('/api/maintenance/groups/') and method == 'DELETE':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin permission required'}, 403)
            gid = path.split('/')[-1]
            res = await maintenance_manager.delete_server_group(gid)
            return await send_json_response(writer, res, status=200 if res.get('success') else 400)

        if path == '/api/terminal/exec' and method == 'POST':
            user = None
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot execute terminal commands.'}, 403)
            target_server = json_body.get('server_id') or json_body.get('serverId') or query_params.get('server_id') or query_params.get('serverId')
            command = json_body.get('command')
            sudo_pass = json_body.get('sudoPassword')
            cwd = json_body.get('cwd')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/terminal/exec', 'POST', json_body={'command': command, 'sudoPassword': sudo_pass, 'cwd': cwd})
                if ENTERPRISE_AVAILABLE and user:
                    await audit.log_action(
                        "terminal.exec", user_id=user['id'], user_email=user['email'],
                        resource_type="terminal",
                        details={"command": command[:200] if command else "", "server_id": target_server}
                    )
                return await send_json_response(writer, res_data, status=code)
            res_data = await terminal.exec_terminal_command(command, sudo_pass, cwd=cwd)
            if ENTERPRISE_AVAILABLE and user:
                await audit.log_action(
                    "terminal.exec", user_id=user['id'], user_email=user['email'],
                    resource_type="terminal",
                    details={"command": command[:200] if command else ""}
                )
            return await send_json_response(writer, res_data)

        if path == '/api/logs' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_server = query_params.get('server_id') or query_params.get('serverId')
            lines_val = query_params.get('lines', '50')
            if target_server and target_server != 'local-master':
                res_data, code = await proxy_to_agent(target_server, '/api/logs', 'GET', query_params={'lines': lines_val})
                return await send_json_response(writer, res_data, status=code)
            # Local master system journal logs
            try:
                import subprocess
                out = subprocess.check_output(['journalctl', '-n', str(lines_val), '--no-pager'], text=True, timeout=5)
                logs = []
                for line_entry in out.splitlines():
                    logs.append({"time": datetime.utcnow().isoformat() + "Z", "line": line_entry})
                return await send_json_response(writer, {'success': True, 'logs': logs})
            except Exception as e:
                return await send_json_response(writer, {'success': True, 'logs': [{"time": datetime.utcnow().isoformat() + "Z", "line": f"Local system log: {str(e)}"}]})

        if path == '/api/vnc/status' and method == 'GET':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
            target_host = query_params.get('host', '127.0.0.1')
            server_id = query_params.get('server_id')
            res_data = await vnc.get_vnc_status(target_host, server_id=server_id)
            return await send_json_response(writer, res_data)

        if path == '/api/vnc/launch' and method == 'POST':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot launch VNC sessions.'}, 403)
            display = json_body.get('display', ':0')
            vnc_port = int(json_body.get('port', 0) or 0)
            backend = json_body.get('backend', 'x11vnc')
            geometry = json_body.get('geometry', '1280x800')
            server_id = json_body.get('server_id')
            res_data = await vnc.launch_vnc(display=display, port=vnc_port, backend=backend, geometry=geometry, server_id=server_id)
            return await send_json_response(writer, res_data)

        if path == '/api/vnc/stop' and method == 'POST':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot stop VNC sessions.'}, 403)
            backend = json_body.get('backend', '')
            server_id = json_body.get('server_id')
            res_data = await vnc.stop_vnc_backend(backend, server_id=server_id)
            return await send_json_response(writer, res_data)

        if path == '/api/vnc/install' and method == 'POST':
            if ENTERPRISE_AVAILABLE:
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Permission denied: Viewers cannot install VNC backends.'}, 403)
            backend = json_body.get('backend', 'x11vnc')
            server_id = json_body.get('server_id')
            res_data = await vnc.install_backend(backend, server_id=server_id)
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
                peer = writer.get_extra_info('peername')
                peer_ip = peer[0] if peer else '127.0.0.1'
                ip = headers.get('x-forwarded-for', '').split(',')[0].strip() or peer_ip

                if not await auth.check_rate_limit(ip):
                    return await send_json_response(writer, {'detail': 'Too many attempts'}, 429)

                db_user = await users_module.get_user_by_email(email)
                if not db_user or not db_user.get('is_active'):
                    await audit.log_action('auth.login', user_email=email, ip_address=ip, result='failure',
                                           details={'reason': 'invalid_credentials'})
                    return await send_json_response(writer, {'detail': 'Invalid email or password'}, 401)

                if db_user.get('locked_until'):
                    try:
                        lock_dt = datetime.fromisoformat(db_user['locked_until'])
                        if lock_dt.tzinfo is None:
                            lock_dt = lock_dt.replace(tzinfo=timezone.utc)
                        if datetime.now(timezone.utc) < lock_dt:
                            await audit.log_action('auth.login', user_email=email, ip_address=ip, result='failure',
                                                   details={'reason': 'account_locked', 'locked_until': db_user.get('locked_until')})
                            return await send_json_response(writer, {'detail': f"Account locked until {db_user.get('locked_until')}"}, 423)
                    except Exception:
                        pass

                if not users_module.verify_password(password, db_user['password_hash']):
                    await auth.record_failed_login(db_user['id'], email, ip)
                    await audit.log_action('auth.login', user_email=email, ip_address=ip, result='failure',
                                           details={'reason': 'invalid_credentials'})
                    return await send_json_response(writer, {'detail': 'Invalid email or password'}, 401)

                user = db_user

                if user.get('totp_enabled') and not totp_code:
                    return await send_json_response(writer, {'totp_required': True})

                if user.get('totp_enabled') and totp_code:
                    if not await auth.verify_totp_or_backup(user, totp_code):
                        await auth.record_failed_login(user['id'], email, ip)
                        await audit.log_action('auth.login', user_id=user['id'], user_email=email, ip_address=ip,
                                               result='failure', details={'reason': 'invalid_totp'})
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
                user = await auth.get_current_user(headers.get('authorization', ''))
                if user:
                    jti = user.get('jti')
                    exp = user.get('exp')
                    if jti and exp:
                        expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
                        await auth.blacklist_token(jti, expires_at)
                    await audit.log_action('auth.logout', user_id=user['id'], user_email=user['email'])
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

            if path == '/api/auth/2fa/setup' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                import pyotp
                import io
                import qrcode

                secret = pyotp.random_base32()
                await database.execute(
                    "UPDATE users SET totp_secret = ? WHERE id = ?",
                    (secret, user['id'])
                )
                otpauth_uri = pyotp.totp.TOTP(secret).provisioning_uri(
                    name=user['email'],
                    issuer_name="PulseOps"
                )
                qr_img = qrcode.make(otpauth_uri)
                buf = io.BytesIO()
                qr_img.save(buf, format="PNG")
                qr_data_url = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('utf-8')}"
                return await send_json_response(writer, {
                    'success': True,
                    'secret': secret,
                    'otpauth_uri': otpauth_uri,
                    'qr_data_url': qr_data_url,
                })

            if path == '/api/auth/2fa/verify' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                import secrets
                import pyotp

                code = json_body.get('code', '').strip()
                if not code or len(code) != 6:
                    return await send_json_response(writer, {'detail': 'A valid 6-digit code is required'}, 400)

                u = await users_module.get_user_by_id(user['id'])
                secret = u.get('totp_secret') if u else None
                if not secret:
                    return await send_json_response(writer, {'detail': '2FA setup not initiated'}, 400)

                totp = pyotp.TOTP(secret)
                if not totp.verify(code):
                    return await send_json_response(writer, {'detail': 'Invalid 2FA code'}, 400)

                backup_codes = [f"{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}" for _ in range(8)]
                await users_module.update_user_totp(
                    user_id=user['id'],
                    secret=secret,
                    enabled=True,
                    backup_codes=json.dumps(backup_codes)
                )
                ip = headers.get('x-forwarded-for', 'unknown').split(',')[0].strip()
                await audit.log_action(
                    'auth.2fa.enable',
                    user_id=user['id'],
                    user_email=user['email'],
                    ip_address=ip
                )
                return await send_json_response(writer, {'success': True, 'backup_codes': backup_codes})

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
                    driver_type=json_body.get('driver_type', 'agent'),
                    driver_config=json_body.get('driver_config', {}),
                )
                if not result['success']:
                    return await send_json_response(writer, {'detail': result['error']}, 400)
                await audit.log_action('fleet.server.add', user_id=user['id'], user_email=user['email'], resource_type='server', details={'hostname': json_body.get('hostname'), 'driver_type': json_body.get('driver_type', 'agent')})
                return await send_json_response(writer, result)

            if path == '/api/fleet/test-connection' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                result = await fleet_module.test_server_connection(
                    driver_type=json_body.get('driver_type', 'agent'),
                    host_ip=json_body.get('host_ip', ''),
                    port=int(json_body.get('port') or json_body.get('agent_port') or 0),
                    config=json_body.get('driver_config') or json_body.get('config') or {},
                )
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
                peer = writer.get_extra_info('peername')
                print(f"[HEARTBEAT INCOMING] token={repr(agent_token)} from {peer}")
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

            # ── Alert rules & incidents ───────────────────────────────────────────
            if path == '/api/alerts/rules' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                server_id = query_params.get('server_id')
                include_inactive = query_params.get('all') == '1'
                return await send_json_response(writer, await alerts_module.list_alert_rules(server_id, include_inactive=include_inactive))

            if path == '/api/alerts/rules' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                result = await alerts_module.create_alert_rule(
                    name=json_body.get('name', ''), metric=json_body.get('metric', 'cpu_percent'),
                    operator=json_body.get('operator', 'gt'), threshold=json_body.get('threshold'),
                    severity=json_body.get('severity', 'warning'), server_id=json_body.get('server_id'),
                    notify_email=json_body.get('notify_email', False), notify_webhook=json_body.get('notify_webhook', False),
                    webhook_url=json_body.get('webhook_url'), channel_type=json_body.get('channel_type', 'webhook'),
                    target_service=json_body.get('target_service'), cooldown_minutes=int(json_body.get('cooldown_minutes', 15) or 15),
                    created_by=user['id'],
                )
                if not result['success']:
                    return await send_json_response(writer, {'detail': result['error']}, 400)
                return await send_json_response(writer, result)

            if path.startswith('/api/alerts/rules/') and path.endswith('/toggle') and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                try:
                    rule_id = int(path.split('/')[4])
                except (IndexError, ValueError):
                    return await send_json_response(writer, {'detail': 'Invalid rule ID'}, 400)
                result = await alerts_module.toggle_alert_rule(rule_id)
                return await send_json_response(writer, result)

            if path.startswith('/api/alerts/rules/') and path.endswith('/test') and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                try:
                    rule_id = int(path.split('/')[4])
                except (IndexError, ValueError):
                    return await send_json_response(writer, {'detail': 'Invalid rule ID'}, 400)
                result = await alerts_module.test_alert_rule(rule_id)
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

            if path.startswith('/api/alerts/active/') and path.endswith('/ack') and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                try:
                    alert_id = int(path.split('/')[4])
                except (IndexError, ValueError):
                    return await send_json_response(writer, {'detail': 'Invalid alert ID'}, 400)
                result = await alerts_module.acknowledge_alert(alert_id, user.get('email', 'operator'), note=json_body.get('note', ''))
                return await send_json_response(writer, result)

            if path.startswith('/api/alerts/active/') and path.endswith('/resolve') and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') not in ('admin', 'operator'):
                    return await send_json_response(writer, {'detail': 'Operator access required'}, 403)
                try:
                    alert_id = int(path.split('/')[4])
                except (IndexError, ValueError):
                    return await send_json_response(writer, {'detail': 'Invalid alert ID'}, 400)
                result = await alerts_module.resolve_alert_manual(alert_id, user.get('email', 'operator'))
                return await send_json_response(writer, result)

            if path == '/api/alerts/history' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                limit = int(query_params.get('limit', 100))
                server_id = query_params.get('server_id')
                return await send_json_response(writer, await alerts_module.get_all_alerts(limit, server_id))

            if path == '/api/alerts/stats' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user:
                    return await send_json_response(writer, {'detail': 'Unauthorized'}, 401)
                return await send_json_response(writer, await alerts_module.get_alert_stats())

            if path == '/api/alerts/test-webhook' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                url = json_body.get('webhook_url', '')
                channel_type = json_body.get('channel_type', 'webhook')
                if not url:
                    return await send_json_response(writer, {'detail': 'webhook_url is required'}, 400)
                result = await alerts_module.test_webhook_channel(url, channel_type)
                return await send_json_response(writer, result)

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
            if path == '/api/settings/public' and method == 'GET':
                nav_keys = [
                    'app_name', 'maintenance_mode', 'maintenance_message',
                    'nav_docker_enabled', 'nav_ports_enabled', 'nav_firewall_enabled',
                    'nav_security_enabled', 'nav_ssl_enabled', 'nav_services_enabled',
                    'nav_processes_enabled', 'nav_logs_enabled', 'nav_terminal_enabled',
                    'nav_vnc_enabled', 'nav_alerts_enabled', 'nav_audit_enabled'
                ]
                result = {}
                if ENTERPRISE_AVAILABLE:
                    placeholders = ','.join(['?'] * len(nav_keys))
                    rows = await database.fetchall(f"SELECT key, value FROM settings WHERE key IN ({placeholders})", tuple(nav_keys))
                    for row in rows:
                        result[row['key']] = row['value']
                for k in nav_keys:
                    if k not in result:
                        result[k] = "true" if k.startswith("nav_") else ""
                return await send_json_response(writer, result)

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
                allowed = {
                    'app_name', 'session_timeout_hours', 'master_url', 'timezone', 'maintenance_mode', 'maintenance_message',
                    'metric_poll_interval', 'chart_history_points', 'top_processes_count', 'bandwidth_unit', 'temperature_unit', 'sound_alerts_enabled',
                    'agent_poll_interval', 'snapshot_retention_hours', 'global_cpu_alert_threshold', 'global_mem_alert_threshold', 'global_disk_alert_threshold',
                    'webhook_enabled', 'webhook_url', 'webhook_format', 'webhook_secret',
                    'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_from',
                    'ssl_warn_days', 'ssl_crit_days', 'ssl_auto_check_hours', 'ssl_alert_untrusted',
                    'require_2fa', 'max_login_attempts', 'lockout_duration_minutes', 'password_min_length', 'idle_timeout_minutes', 'admin_ip_allowlist',
                    'terminal_font_size', 'terminal_scrollback_lines', 'terminal_theme', 'terminal_confirm_sudo', 'terminal_audit_logging',
                    'nav_docker_enabled', 'nav_ports_enabled', 'nav_firewall_enabled', 'nav_security_enabled', 'nav_ssl_enabled',
                    'nav_services_enabled', 'nav_processes_enabled', 'nav_logs_enabled', 'nav_terminal_enabled', 'nav_vnc_enabled',
                    'nav_alerts_enabled', 'nav_audit_enabled'
                }
                count = 0
                for key, value in json_body.items():
                    if key in allowed:
                        await database.set_setting(key, str(value), user['id'])
                        count += 1
                await audit.log_action(
                    'settings.update', user_id=user['id'], user_email=user['email'],
                    details={'keys': [k for k in json_body if k in allowed]}
                )
                return await send_json_response(writer, {'success': True, 'updated_count': count})

            if path == '/api/admin/settings/test-smtp' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                result = await alerts_module.send_test_email()
                code = 200 if result.get('success') else 400
                return await send_json_response(writer, result, code)

            if path == '/api/admin/settings/test-webhook' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                url = json_body.get('webhook_url', '').strip()
                fmt = json_body.get('webhook_format', 'slack').strip().lower()
                if not url:
                    saved_url = await database.get_setting('webhook_url')
                    url = (saved_url or '').strip()
                if not url:
                    return await send_json_response(writer, {'success': False, 'detail': 'No webhook URL provided or configured'}, 400)

                test_title = "PulseOps Enterprise Notification Test"
                test_body = f"Test notification triggered by {user.get('email')} at {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}. Webhook alerts integration is active."
                if fmt == 'slack':
                    payload = {
                        "text": f"*{test_title}*\n{test_body}",
                        "attachments": [{"color": "#38bdf8", "fields": [{"title": "Status", "value": "Healthy", "short": True}]}]
                    }
                elif fmt == 'discord':
                    payload = {
                        "username": "PulseOps Observability",
                        "embeds": [{
                            "title": test_title,
                            "description": test_body,
                            "color": 3719160
                        }]
                    }
                else:
                    payload = {
                        "event": "test.notification",
                        "title": test_title,
                        "message": test_body,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "user": user.get('email')
                    }

                try:
                    data_bytes = json.dumps(payload).encode('utf-8')
                    req = urllib.request.Request(
                        url, data=data_bytes,
                        headers={'Content-Type': 'application/json', 'User-Agent': 'PulseOps-Webhook-Client/2.0'},
                        method='POST'
                    )
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        resp_body = resp.read().decode('utf-8', errors='replace')
                        return await send_json_response(writer, {
                            'success': True,
                            'status_code': resp.status,
                            'response': resp_body[:200]
                        })
                except Exception as e:
                    return await send_json_response(writer, {
                        'success': False,
                        'detail': f"Webhook delivery failed: {str(e)}"
                    }, 400)

            if path == '/api/admin/settings/reset-defaults' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                for key, val, dtype in database.DEFAULT_SETTINGS:
                    await database.set_setting(key, val, user['id'])
                await audit.log_action('settings.reset_defaults', user_id=user['id'], user_email=user['email'])
                return await send_json_response(writer, {'success': True, 'count': len(database.DEFAULT_SETTINGS)})

            if path == '/api/admin/database/stats' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                db_path = database.DB_PATH if hasattr(database, "DB_PATH") else os.path.join(os.path.dirname(__file__), "pulseops.db")
                db_size = os.path.getsize(db_path) if os.path.exists(db_path) else 0
                wal_path = db_path + "-wal"
                wal_size = os.path.getsize(wal_path) if os.path.exists(wal_path) else 0

                s_row = await database.fetchone("SELECT COUNT(*) as c FROM servers")
                snap_row = await database.fetchone("SELECT COUNT(*) as c FROM server_snapshots")
                a_row = await database.fetchone("SELECT COUNT(*) as c FROM audit_log")
                u_row = await database.fetchone("SELECT COUNT(*) as c FROM users")
                r_row = await database.fetchone("SELECT COUNT(*) as c FROM alert_rules")
                m_row = await database.fetchone("SELECT COUNT(*) as c FROM ssl_monitored_domains")

                return await send_json_response(writer, {
                    'db_path': db_path,
                    'db_size_bytes': db_size,
                    'wal_size_bytes': wal_size,
                    'total_size_mb': round((db_size + wal_size) / (1024 * 1024), 2),
                    'servers_count': s_row['c'] if s_row else 0,
                    'snapshots_count': snap_row['c'] if snap_row else 0,
                    'audit_logs_count': a_row['c'] if a_row else 0,
                    'users_count': u_row['c'] if u_row else 0,
                    'alert_rules_count': r_row['c'] if r_row else 0,
                    'monitored_domains_count': m_row['c'] if m_row else 0
                })

            if path == '/api/admin/database/vacuum' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                db_path = database.DB_PATH if hasattr(database, "DB_PATH") else os.path.join(os.path.dirname(__file__), "pulseops.db")
                before_size = os.path.getsize(db_path) if os.path.exists(db_path) else 0
                db = await database.get_db()
                await db.execute("VACUUM")
                after_size = os.path.getsize(db_path) if os.path.exists(db_path) else 0
                reclaimed = max(0, before_size - after_size)
                await audit.log_action('database.vacuum', user_id=user['id'], user_email=user['email'],
                                       details={'reclaimed_bytes': reclaimed})
                return await send_json_response(writer, {
                    'success': True,
                    'size_before_bytes': before_size,
                    'size_after_bytes': after_size,
                    'reclaimed_bytes': reclaimed,
                    'reclaimed_kb': round(reclaimed / 1024, 1)
                })

            if path == '/api/admin/database/purge-metrics' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                hours_str = json_body.get('retention_hours')
                if not hours_str:
                    hours_str = await database.get_setting('snapshot_retention_hours') or "24"
                try:
                    hours = max(1, int(hours_str))
                except Exception:
                    hours = 24
                await database.execute(
                    "DELETE FROM server_snapshots WHERE timestamp < datetime('now', '-' || ? || ' hours')",
                    (hours,)
                )
                await audit.log_action('database.purge_metrics', user_id=user['id'], user_email=user['email'],
                                       details={'retention_hours': hours})
                return await send_json_response(writer, {'success': True, 'retention_hours': hours})

            if path == '/api/admin/backup' and method == 'GET':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                db_path = database.DB_PATH if hasattr(database, "DB_PATH") else os.path.join(os.path.dirname(__file__), "pulseops.db")
                if not os.path.exists(db_path):
                    return await send_json_response(writer, {'detail': 'Database file not found'}, 404)
                
                temp_backup = os.path.join(os.path.dirname(db_path), f"pulseops.backup_export_{int(time.time())}.db")
                try:
                    await database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    conn = sqlite3.connect(db_path)
                    conn.execute(f'VACUUM INTO "{temp_backup}"')
                    conn.close()
                    with open(temp_backup, 'rb') as f:
                        db_bytes = f.read()
                except Exception as b_err:
                    print(f"[Backup] VACUUM INTO error, fallback to direct read: {b_err}")
                    with open(db_path, 'rb') as f:
                        db_bytes = f.read()
                finally:
                    if os.path.exists(temp_backup):
                        try:
                            os.remove(temp_backup)
                        except Exception:
                            pass

                today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                filename = f"pulseops-backup-{today}.db"
                res_hdr = (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: application/octet-stream\r\n"
                    f"Content-Disposition: attachment; filename={filename}\r\n"
                    f"Content-Length: {len(db_bytes)}\r\n\r\n"
                )
                writer.write(res_hdr.encode() + db_bytes)
                await writer.drain()
                writer.close()
                return

            if path == '/api/admin/restore' and method == 'POST':
                user = await auth.get_current_user(headers.get('authorization', ''))
                if not user or user.get('role') != 'admin':
                    return await send_json_response(writer, {'detail': 'Admin access required'}, 403)
                if not body_data or len(body_data) < 100:
                    return await send_json_response(writer, {'detail': 'No database file provided or file is empty'}, 400)

                # Verify SQLite magic header
                if not body_data.startswith(b"SQLite format 3\x00"):
                    return await send_json_response(writer, {'detail': 'Invalid file format: Uploaded file is not a valid SQLite database.'}, 400)

                db_path = database.DB_PATH if hasattr(database, "DB_PATH") else os.path.join(os.path.dirname(__file__), "pulseops.db")
                temp_restore_path = db_path + f".restore_tmp_{int(time.time())}.db"
                safety_backup_path = db_path + f".pre_restore_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.bak"

                try:
                    # Write candidate file
                    with open(temp_restore_path, 'wb') as f:
                        f.write(body_data)

                    # Verify integrity with sqlite3
                    chk_conn = sqlite3.connect(temp_restore_path)
                    try:
                        chk_cursor = chk_conn.cursor()
                        chk_cursor.execute("PRAGMA integrity_check;")
                        chk_row = chk_cursor.fetchone()
                        if not chk_row or str(chk_row[0]).lower() != "ok":
                            return await send_json_response(writer, {'detail': f'SQLite integrity check failed: {chk_row}'}, 400)

                        chk_cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
                        tables = {r[0] for r in chk_cursor.fetchall()}
                        if "users" not in tables or "settings" not in tables:
                            return await send_json_response(writer, {'detail': 'Database schema invalid: Missing essential PulseOps tables (users, settings).'}, 400)
                    finally:
                        chk_conn.close()

                    # Create pre-restore safety backup of existing database
                    if os.path.exists(db_path):
                        try:
                            await database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                        except Exception:
                            pass
                        shutil.copy2(db_path, safety_backup_path)

                    # Swap database under connection lock
                    async with database.get_db_lock():
                        await database.close_db()
                        for ext in ["-wal", "-shm"]:
                            wal_f = db_path + ext
                            if os.path.exists(wal_f):
                                try:
                                    os.remove(wal_f)
                                except Exception:
                                    pass
                        shutil.move(temp_restore_path, db_path)

                    # Re-initialize DB (acquires lock cleanly on new connection)
                    await database.init_db()

                    await audit.log_action('database.restore', user_id=user['id'], user_email=user['email'],
                                           details={'bytes': len(body_data), 'safety_backup': os.path.basename(safety_backup_path)})
                    return await send_json_response(writer, {
                        'success': True,
                        'message': 'Database restored and validated successfully.',
                        'safety_backup': os.path.basename(safety_backup_path)
                    })
                except Exception as ex:
                    return await send_json_response(writer, {'detail': f'Restore failed: {str(ex)}'}, 500)
                finally:
                    if os.path.exists(temp_restore_path):
                        try:
                            os.remove(temp_restore_path)
                        except Exception:
                            pass


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
        "Connection: close\r\n"
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
    _cycle_count = 0
    while True:
        await asyncio.sleep(2.0)
        try:
            data = await telemetry.get_full_telemetry()
            if ENTERPRISE_AVAILABLE:
                try:
                    fleet_module.update_local_snapshot("local-master", data)
                    _cycle_count += 1
                    # Evaluate local master alert rules every 4 seconds (every 2 cycles)
                    if _cycle_count % 2 == 0:
                        asyncio.create_task(alerts_module.evaluate_alerts_for_server("local-master", data))
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
            alerts_module.set_broadcast_callback(_alert_broadcast)
            asyncio.create_task(fleet_module.fleet_health_poll_loop())
            print("✅ Enterprise features initialized (DB, Auth, Fleet, Alerts)")
        except Exception as e:
            print(f"[Warning] Enterprise init error: {e}")

    server = await asyncio.start_server(handle_http_request, HOST, PORT)
    print("\n⚡ PulseOps Enterprise Server running:")
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

    # ── VNC subsystem: report availability, don't auto-launch an X server ───
    try:
        vnc_status = await vnc.get_vnc_status()
        available = [k for k, v in vnc_status['backends'].items() if v['installed']]
        if available:
            print(f"   ➜ VNC:      backends ready: {', '.join(available)} (launch from the VNC tab)")
        else:
            print(f"   ➜ VNC:      no backend installed yet. Install cmd: {vnc_status.get('installCmd')}")
    except Exception as e:
        print(f"[Warning] VNC status check error: {e}")

    async with server:
        await server.serve_forever()


async def _fleet_broadcast(payload: dict) -> None:
    """Broadcast a fleet update to all connected WebSocket clients."""
    msg = json.dumps(payload)
    for ws in list(connected_ws_clients):
        if ws.open and not ws.is_vnc:
            asyncio.create_task(ws.send_text(msg))


async def _alert_broadcast(payload: dict) -> None:
    """Broadcast an alert event to all connected WebSocket clients."""
    msg = json.dumps(payload)
    for ws in list(connected_ws_clients):
        if ws.open and not ws.is_vnc:
            asyncio.create_task(ws.send_text(msg))

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nPulseOps Python Server stopped.")
