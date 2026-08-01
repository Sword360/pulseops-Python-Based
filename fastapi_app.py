import os
import json
import random
import asyncio
from datetime import datetime
from typing import Dict, Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

import telemetry
import services
import processes
import terminal
import vnc

app = FastAPI(title="PulseOps Python API", description="Real-time Linux server management dashboard and telemetry platform in Python")

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), 'public')
if os.path.exists(PUBLIC_DIR):
    app.mount("/css", StaticFiles(directory=os.path.join(PUBLIC_DIR, "css")), name="css")
    app.mount("/js", StaticFiles(directory=os.path.join(PUBLIC_DIR, "js")), name="js")

connected_clients = set()

@app.get("/")
async def get_index():
    index_path = os.path.join(PUBLIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return HTMLResponse("<h1>PulseOps Python Dashboard</h1>")

@app.get("/api/services")
async def api_get_services():
    return await services.get_services()

@app.post("/api/services/action")
async def api_action_service(payload: Dict[str, Any] = Body(...)):
    service_name = payload.get("serviceName")
    action = payload.get("action")
    res = await services.action_service(service_name, action)
    if not res.get("success"):
        return JSONResponse(status_code=400, content=res)
    return res

@app.get("/api/services/{name}/logs")
async def api_service_logs(name: str):
    return await services.get_service_logs(name)

@app.get("/api/processes")
async def api_get_processes():
    return await processes.get_processes()

@app.post("/api/processes/kill")
async def api_kill_process(payload: Dict[str, Any] = Body(...)):
    pid = payload.get("pid")
    signal_val = payload.get("signal", "15")
    res = await processes.kill_process(pid, signal_val)
    if not res.get("success"):
        return JSONResponse(status_code=400, content=res)
    return res

@app.post("/api/terminal/exec")
async def api_exec_terminal(payload: Dict[str, Any] = Body(...)):
    command = payload.get("command")
    sudo_pass = payload.get("sudoPassword")
    return await terminal.exec_terminal_command(command, sudo_pass)

@app.get("/api/vnc/status")
async def api_vnc_status(host: str = "127.0.0.1"):
    return await vnc.get_vnc_status(host)

@app.post("/api/vnc/launch")
async def api_vnc_launch(payload: Dict[str, Any] = Body(...)):
    display = payload.get("display", ":0")
    port = int(payload.get("port", 5900))
    use_native = bool(payload.get("useNative", False))
    return await vnc.launch_vnc(display, port, use_native)

@app.websocket("/")
async def websocket_telemetry_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    print("Client connected to FastAPI telemetry stream.")
    
    initial_data = await telemetry.get_full_telemetry()
    await websocket.send_text(json.dumps({"type": "telemetry", "data": initial_data}))

    try:
        while True:
            msg = await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.remove(websocket)
        print("Client disconnected from FastAPI telemetry stream.")

@app.websocket("/api/vnc/ws")
async def websocket_vnc_proxy(websocket: WebSocket, host: str = "127.0.0.1", port: int = 5900):
    await websocket.accept()
    print(f"[VNC Proxy] Initiating FastAPI connection to RFB server at {host}:{port}")

    try:
        reader, writer = await asyncio.open_connection(host, port)
        await websocket.send_text(json.dumps({
            "type": "vnc_proxy_meta",
            "status": "connected",
            "host": host,
            "port": port
        }))

        async def forward_tcp():
            try:
                while not reader.at_eof():
                    data = await reader.read(4096)
                    if not data:
                        break
                    await websocket.send_bytes(data)
            except Exception:
                pass

        asyncio.create_task(forward_tcp())

        while True:
            msg = await websocket.receive()
            if "bytes" in msg and msg["bytes"]:
                writer.write(msg["bytes"])
                await writer.drain()
            elif "text" in msg and msg["text"]:
                writer.write(msg["text"].encode('utf-8'))
                await writer.drain()
    except Exception as e:
        print(f"[VNC Proxy Error]: {e}")
        try:
            await websocket.send_text(json.dumps({"type": "vnc_proxy_meta", "status": "error", "error": str(e)}))
        except Exception:
            pass

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(telemetry_loop())
    asyncio.create_task(log_stream_loop())

async def telemetry_loop():
    while True:
        await asyncio.sleep(2.0)
        if connected_clients:
            data = await telemetry.get_full_telemetry()
            payload = json.dumps({"type": "telemetry", "data": data})
            for client in list(connected_clients):
                try:
                    await client.send_text(payload)
                except Exception:
                    pass

async def log_stream_loop():
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
        if connected_clients:
            log_entry = {
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "level": random.choice(log_levels),
                "source": random.choice(log_sources),
                "message": random.choice(sample_messages)
            }
            payload = json.dumps({"type": "logStream", "data": log_entry})
            for client in list(connected_clients):
                try:
                    await client.send_text(payload)
                except Exception:
                    pass
