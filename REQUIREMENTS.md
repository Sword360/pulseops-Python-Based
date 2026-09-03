# ⚡ PulseOps (Python Edition) — Architecture & Specifications

## 1. Overview

**PulseOps (Python Edition)** is a real-time Linux server management dashboard and telemetry platform built using Python architecture. It provides identical REST APIs, WebSockets, static UI rendering, process management, systemd control, web terminal, and embedded VNC server capabilities as the Node.js edition.

---

## 2. Technology Stack & Architecture

```
+-----------------------------------------------------------------------+
|                            PulseOps UI                                |
|          (Obsidian Glassmorphic HTML5 / Vanilla CSS3 / JS)            |
+-----------------------------------+-----------------------------------+
                                    |
            HTTP REST APIs          |         WebSockets
           (JSON Requests)          |      (Telemetry / Logs / RFB)
                                    v
+-----------------------------------------------------------------------+
|                       Python Asyncio Engine                           |
|                       (server.py / fastapi_app.py)                    |
+------------------+------------------+------------------+--------------+
                   |                  |                  |
                   v                  v                  v
            +--------------+   +--------------+   +--------------+
            |  Linux /proc |   |  Systemd &   |   |   Embedded   |
            |  Subsystem    |   |  CLI Exec    |   |   RFB VNC    |
            +--------------+   +--------------+   +--------------+
```

* **Runtime**: Python 3.10+ (Standard Library `asyncio`, `socket`, `struct`, `hashlib`, `json`).
* **Optional Framework**: FastAPI + Uvicorn (`fastapi_app.py`).
* **Telemetry**: Direct Linux `/proc` parsing (`/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `/proc/uptime`) with optional `psutil` acceleration.

---

## 3. Quick Start

### Standard Run (Zero Dependencies Required)
```bash
python3 server.py
```
The server binds to `0.0.0.0:3500` by default and will output both the local and network URLs (e.g. `http://<YOUR_IP>:3500`).

### FastAPI / Uvicorn Run (Optional)
```bash
pip install -r requirements.txt
uvicorn fastapi_app:app --host 0.0.0.0 --port 3500
```

### Accessing from Other Devices on the Same Network
1. Ensure port 3500 is open in your firewall:
   ```bash
   sudo firewall-cmd --add-port=3500/tcp --permanent
   sudo firewall-cmd --reload
   ```
2. Open any web browser on a device connected to the same network and navigate to:
   `http://<SERVER_IP>:3500`
