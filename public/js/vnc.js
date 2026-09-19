/**
 * PulseOps Enterprise — Real-Time Linux Infrastructure Management
 * ============================================================================
 * Module:      vnc.js
 * Description: HTML5 Canvas RFB 3.8 remote desktop client engine with auto-scaling and clipboard integration.
 *
 * @author      Najmul Islam
 * @developer   Najmul Islam
 * @contact     f2pnajmul@gmail.com
 * @license     MIT License (see LICENSE file for details)
 * @copyright   (c) 2026 Najmul Islam. All rights reserved.
 * ============================================================================
 */

class PulseOpsVNCManager {
    constructor() {
        this.serverId = 'local-master';
        this.targetHostname = 'Local Master';
        this.targetIp = '127.0.0.1';
        this.targetPort = 5900;

        this.ws = null;
        this.canvas = null;
        this.ctx = null;
        this.isConnected = false;
        this.rfbState = 0; // 0: Init, 1: Security, 2: AuthChallenge, 3: SecurityResult, 4: ServerInit, 5: Connected

        this.width = 1280;
        this.height = 800;
        this.desktopName = 'PulseOps x11vnc Session';
        this.fps = 0;
        this.frameCount = 0;
        this.lastFpsCalc = Date.now();

        // RFB stream accumulator buffer
        this.rxBuffer = new Uint8Array(0);

        // Server pixel format attributes
        this.bitsPerPixel = 32;
        this.depth = 24;
        this.bigEndian = 0;
        this.trueColor = 1;
        this.redMax = 255;
        this.greenMax = 255;
        this.blueMax = 255;
        this.redShift = 0;
        this.greenShift = 8;
        this.blueShift = 16;
        this.nextFrameTimer = null;

        // Display scaling mode: 'fit', '1:1', 'stretch'
        this.scaleMode = 'fit';

        // Mouse button tracking
        this.buttonMask = 0;

        // Pending auth challenge buffer
        this.pendingChallenge = null;

        this.initElements();
        this.initEvents();
        this.checkHostVncStatus();
    }

    initElements() {
        this.canvas = document.getElementById('vnc-canvas');
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d', { alpha: false });
        }

        this.hostInput = document.getElementById('vnc-host-input');
        this.portInput = document.getElementById('vnc-port-input');
        this.passInput = document.getElementById('vnc-pass-input');

        this.connectBtn = document.getElementById('vnc-connect-btn');
        this.disconnectBtn = document.getElementById('vnc-disconnect-btn');
        this.launchBtn = document.getElementById('vnc-launch-btn');
        this.restartBtn = document.getElementById('vnc-restart-btn');
        this.stopBtn = document.getElementById('vnc-stop-btn');

        this.statusDot = document.getElementById('vnc-dot');
        this.statusText = document.getElementById('vnc-status-text');
        this.overlay = document.getElementById('vnc-overlay');
        this.serverInfoBox = document.getElementById('vnc-server-info');
        this.consoleOut = document.getElementById('vnc-console-output');
        this.fpsIndicator = document.getElementById('vnc-fps-indicator');
        this.resBadge = document.getElementById('vnc-res-badge');

        this.targetHostnameEl = document.getElementById('vnc-target-hostname');
        this.targetSubEl = document.getElementById('vnc-target-sub');
        this.tightvncTargetEl = document.getElementById('vnc-tightvnc-target');
        this.copyTargetBtn = document.getElementById('vnc-copy-target-btn');

        this.diagHostEl = document.getElementById('vnc-diag-host');
        this.diagPortEl = document.getElementById('vnc-diag-port');
        this.diagStatusEl = document.getElementById('vnc-diag-status');

        this.authModal = document.getElementById('vnc-auth-modal');
        this.authModalPass = document.getElementById('vnc-auth-modal-pass');
        this.authModalSubmit = document.getElementById('vnc-auth-modal-submit');
        this.authModalCancel = document.getElementById('vnc-auth-modal-cancel');
    }

    initEvents() {
        // Connection buttons
        if (this.connectBtn) this.connectBtn.addEventListener('click', () => this.connect());
        if (this.disconnectBtn) this.disconnectBtn.addEventListener('click', () => this.disconnect());

        // Overlay buttons
        const ovConnect = document.getElementById('vnc-overlay-connect-btn');
        const ovLaunch = document.getElementById('vnc-overlay-launch-btn');
        const ovCopy = document.getElementById('vnc-overlay-copy-btn');

        if (ovConnect) ovConnect.addEventListener('click', () => this.connect());
        if (ovLaunch) ovLaunch.addEventListener('click', () => this.launchHostDaemon());
        if (ovCopy) ovCopy.addEventListener('click', () => this.copyTarget());

        // Management buttons
        if (this.launchBtn) this.launchBtn.addEventListener('click', () => this.launchHostDaemon());
        if (this.restartBtn) this.restartBtn.addEventListener('click', () => this.launchHostDaemon());
        if (this.stopBtn) this.stopBtn.addEventListener('click', () => this.stopHostDaemon());
        if (this.copyTargetBtn) this.copyTargetBtn.addEventListener('click', () => this.copyTarget());

        // Display scaling
        const scaleSelect = document.getElementById('vnc-scale-select');
        if (scaleSelect) {
            scaleSelect.addEventListener('change', (e) => {
                this.scaleMode = e.target.value;
                this.updateCanvasScaling();
            });
        }

        // Fullscreen toggle
        const fsBtn = document.getElementById('vnc-fullscreen-btn');
        if (fsBtn) {
            fsBtn.addEventListener('click', () => {
                const container = document.getElementById('vnc-viewport-container');
                if (container) {
                    if (!document.fullscreenElement) {
                        container.requestFullscreen().catch(err => this.log(`Fullscreen error: ${err.message}`));
                    } else {
                        document.exitFullscreen();
                    }
                }
            });
        }

        // Quick Key Macros
        const cadBtn = document.getElementById('vnc-btn-cad');
        const altTabBtn = document.getElementById('vnc-btn-alttab');
        const superBtn = document.getElementById('vnc-btn-super');
        const escBtn = document.getElementById('vnc-btn-esc');
        const ctrlCBtn = document.getElementById('vnc-btn-ctrlc');
        const ctrlVBtn = document.getElementById('vnc-btn-ctrlv');

        if (cadBtn) cadBtn.addEventListener('click', () => this.sendMacro('CAD'));
        if (altTabBtn) altTabBtn.addEventListener('click', () => this.sendMacro('ALTTAB'));
        if (superBtn) superBtn.addEventListener('click', () => this.sendMacro('SUPER'));
        if (escBtn) escBtn.addEventListener('click', () => this.sendMacro('ESC'));
        if (ctrlCBtn) ctrlCBtn.addEventListener('click', () => this.sendMacro('CTRL_C'));
        if (ctrlVBtn) ctrlVBtn.addEventListener('click', () => this.sendMacro('CTRL_V'));

        // Clipboard Text Sender
        const clipSendBtn = document.getElementById('vnc-clip-send-btn');
        const clipInput = document.getElementById('vnc-clip-input');
        if (clipSendBtn && clipInput) {
            clipSendBtn.addEventListener('click', () => {
                const text = clipInput.value;
                if (text) {
                    this.sendText(text);
                    clipInput.value = '';
                }
            });
            clipInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const text = clipInput.value;
                    if (text) {
                        this.sendText(text);
                        clipInput.value = '';
                    }
                }
            });
        }

        // Auth Modal handlers
        if (this.authModalSubmit && this.authModalPass) {
            this.authModalSubmit.addEventListener('click', () => this.submitAuthModal());
            this.authModalPass.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.submitAuthModal();
            });
        }
        if (this.authModalCancel) {
            this.authModalCancel.addEventListener('click', () => {
                if (this.authModal) this.authModal.style.display = 'none';
                this.disconnect();
            });
        }

        // Mouse & Pointer listeners
        if (this.canvas) {
            this.canvas.addEventListener('mousemove', (e) => this.handlePointerEvent(e, 'move'));
            this.canvas.addEventListener('mousedown', (e) => {
                this.canvas.focus();
                this.handlePointerEvent(e, 'down');
            });
            this.canvas.addEventListener('mouseup', (e) => this.handlePointerEvent(e, 'up'));
            this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            this.canvas.addEventListener('wheel', (e) => this.handleWheelEvent(e), { passive: false });

            // Keyboard listeners
            this.canvas.addEventListener('keydown', (e) => this.handleKeyEvent(e, true));
            this.canvas.addEventListener('keyup', (e) => this.handleKeyEvent(e, false));
        }

        // FPS meter
        setInterval(() => {
            const now = Date.now();
            const elapsed = (now - this.lastFpsCalc) / 1000;
            this.fps = Math.round(this.frameCount / elapsed);
            this.frameCount = 0;
            this.lastFpsCalc = now;
            if (this.fpsIndicator) {
                this.fpsIndicator.textContent = `FPS: ${this.fps}`;
            }
        }, 1000);
    }

    log(msg) {
        if (this.consoleOut) {
            const time = new Date().toLocaleTimeString();
            this.consoleOut.textContent = `[${time}] ${msg}`;
        }
        console.log(`[PulseOps x11vnc] ${msg}`);
    }

    async authFetch(url, options = {}) {
        if (window.PulseOpsAuth && window.PulseOpsAuth.apiFetch) {
            return window.PulseOpsAuth.apiFetch(url, options);
        }
        const token = window.PulseOpsAuth ? window.PulseOpsAuth.getAccessToken() : null;
        const headers = { ...(options.headers || {}) };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return fetch(url, { ...options, headers });
    }

    // ── Server Context Management ──────────────────────────────────────────

    setServer(serverId, hostname, ip) {
        const isMaster = (!serverId || serverId === 'local-master');
        const prevId = this.serverId;
        this.serverId = serverId || 'local-master';
        this.targetHostname = hostname || (isMaster ? 'Local Master' : 'Remote Node');
        this.targetIp = ip || (isMaster ? '127.0.0.1' : (this.hostInput?.value || '127.0.0.1'));
        this.targetPort = 5900;

        if (this.isConnected && prevId !== this.serverId) {
            this.disconnect();
        }

        if (this.targetHostnameEl) this.targetHostnameEl.textContent = this.targetHostname;
        if (this.targetSubEl) this.targetSubEl.textContent = `${this.targetIp} · x11vnc on port ${this.targetPort}`;
        if (this.tightvncTargetEl) this.tightvncTargetEl.textContent = `${this.targetIp}:${this.targetPort}`;
        if (this.hostInput) this.hostInput.value = this.targetIp;
        if (this.portInput) this.portInput.value = this.targetPort;

        if (this.diagHostEl) this.diagHostEl.textContent = `${this.targetHostname} (${this.targetIp})`;
        if (this.diagPortEl) this.diagPortEl.textContent = `${this.targetPort}`;
        if (this.diagStatusEl) this.diagStatusEl.textContent = 'Checking...';

        this.checkHostVncStatus();
    }

    copyTarget() {
        const target = `${this.targetIp}:${this.targetPort}`;
        if (typeof window.copyToClipboard === 'function') {
            window.copyToClipboard(target, `Copied ${target} for TightVNC Viewer!`);
        } else {
            this._fallbackCopy(target);
        }
        this.log(`Copied connection target: ${target}`);
    }

    _fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (window.showToast) window.showToast(`Copied ${text} for TightVNC Viewer!`, 'success');
        this.log(`Copied connection target: ${text}`);
    }

    // ── Server Status & Actions ────────────────────────────────────────────

    async checkHostVncStatus() {
        try {
            const host = this.targetIp || (this.hostInput ? this.hostInput.value.trim() : '127.0.0.1');
            const sid = this.serverId || 'local-master';
            const res = await this.authFetch(`/api/vnc/status?server_id=${encodeURIComponent(sid)}&host=${encodeURIComponent(host)}`);
            const data = await res.json();

            const isRunning = data.running || data.service_active || (data.openPorts && data.openPorts.length > 0);
            const port = data.defaultPort || 5900;
            this.targetPort = port;
            if (this.portInput) this.portInput.value = port;
            if (this.tightvncTargetEl) this.tightvncTargetEl.textContent = `${this.targetIp}:${port}`;

            if (this.diagStatusEl) {
                this.diagStatusEl.textContent = isRunning ? 'Active & Listening' : 'Service Stopped';
                this.diagStatusEl.style.color = isRunning ? 'var(--accent-green)' : 'var(--accent-amber)';
            }

            if (this.serverInfoBox) {
                if (isRunning) {
                    this.serverInfoBox.innerHTML = `
                        <span style="color: var(--accent-green); font-weight: 700;">✓ x11vnc service active and listening on port ${port}</span><br>
                        <span style="font-size: 0.85rem; color: var(--text-main); display: inline-block; margin-top: 4px;">
                            Display: <code>${data.display || ':0'}</code> | Target: <strong>${this.targetIp}:${port}</strong>
                        </span><br>
                        <span style="font-size: 0.8rem; color: var(--accent-cyan); display: inline-block; margin-top: 4px;">
                            🖥️ Ready to connect. Click <strong>"Connect to Desktop"</strong> or use TightVNC Viewer pointing to <code>${this.targetIp}:${port}</code>.
                        </span>
                    `;
                } else {
                    this.serverInfoBox.innerHTML = `
                        <span style="color: var(--accent-amber); font-weight: 600;">ℹ x11vnc is not currently running on port ${port}.</span><br>
                        <span style="font-size: 0.8rem; color: var(--text-dim); display: inline-block; margin-top: 4px;">
                            Click <strong>"Start x11vnc Server"</strong> to start the remote desktop mirror on this node.
                        </span>
                    `;
                }
            }
        } catch (e) {
            if (this.diagStatusEl) {
                this.diagStatusEl.textContent = 'Unreachable';
                this.diagStatusEl.style.color = 'var(--accent-red)';
            }
            if (this.serverInfoBox) {
                this.serverInfoBox.textContent = 'Could not query x11vnc status on node.';
            }
        }
    }

    async launchHostDaemon() {
        if (window.PulseOpsAuth && !window.PulseOpsAuth.isOperator()) {
            if (window.showToast) window.showToast('Permission denied: Viewer accounts cannot launch VNC sessions', 'error');
            return;
        }
        this.log(`Starting x11vnc on ${this.targetHostname} (${this.serverId})...`);
        if (window.showToast) window.showToast(`Starting x11vnc on ${this.targetHostname}...`, 'info');
        try {
            const res = await this.authFetch('/api/vnc/launch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    backend: 'x11vnc',
                    server_id: this.serverId,
                    port: this.targetPort || 5900,
                    geometry: '1280x800'
                })
            });
            const data = await res.json();
            if (data.success) {
                if (window.showToast) window.showToast(data.message || 'x11vnc started successfully.', 'success');
                this.log(data.message || 'x11vnc started.');
                setTimeout(() => {
                    this.checkHostVncStatus();
                    this.connect(); // Auto connect!
                }, 1000);
            } else {
                if (window.showToast) window.showToast(data.error || 'Failed to start x11vnc.', 'error');
                this.log(`Start error: ${data.error}`);
            }
        } catch (e) {
            if (window.showToast) window.showToast(`Failed: ${e.message}`, 'error');
        }
    }

    async stopHostDaemon() {
        if (window.PulseOpsAuth && !window.PulseOpsAuth.isOperator()) {
            if (window.showToast) window.showToast('Permission denied: Viewer accounts cannot stop VNC sessions', 'error');
            return;
        }
        this.log(`Stopping x11vnc on ${this.targetHostname}...`);
        try {
            const res = await this.authFetch('/api/vnc/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    backend: 'x11vnc',
                    server_id: this.serverId
                })
            });
            const data = await res.json();
            if (data.success) {
                if (window.showToast) window.showToast(data.message || 'x11vnc stopped.', 'success');
                this.log(data.message || 'x11vnc stopped.');
                this.disconnect();
                this.checkHostVncStatus();
            } else {
                if (window.showToast) window.showToast(data.error || 'Stop failed.', 'error');
            }
        } catch (e) {
            if (window.showToast) window.showToast(`Stop failed: ${e.message}`, 'error');
        }
    }

    // ── WebSocket Connection & RFB 3.8 Handshake ──────────────────────────

    connect() {
        if (window.PulseOpsAuth && !window.PulseOpsAuth.isOperator()) {
            if (window.showToast) window.showToast('Permission denied: Viewer accounts cannot launch VNC sessions', 'error');
            return;
        }
        if (this.nextFrameTimer) {
            clearTimeout(this.nextFrameTimer);
            this.nextFrameTimer = null;
        }
        this.rxBuffer = new Uint8Array(0);
        this.rfbState = 0;
        this.pendingChallenge = null;

        const host = this.hostInput ? this.hostInput.value.trim() : (this.targetIp || '127.0.0.1');
        const port = this.portInput ? this.portInput.value.trim() : (this.targetPort || '5900');
        const sid = this.serverId || 'local-master';

        this.log(`Opening WebSocket RFB tunnel to ${host}:${port} (server_id: ${sid})...`);
        this.updateStatus('CONNECTING', 'warning');

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const token = (window.PulseOpsAuth && window.PulseOpsAuth.getAccessToken)
            ? window.PulseOpsAuth.getAccessToken()
            : (localStorage.getItem('pulseops_access_token') || '');
        const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
        const wsUrl = `${protocol}//${window.location.host}/api/vnc/ws?server_id=${encodeURIComponent(sid)}&host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}${tokenParam}`;

        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                this.log('WebSocket tunnel established. Handshaking RFB 3.8...');
                this.rfbState = 0;
            };

            this.ws.onmessage = (evt) => {
                if (typeof evt.data === 'string') {
                    try {
                        const meta = JSON.parse(evt.data);
                        if (meta.type === 'vnc_proxy_meta') {
                            this.log(`Proxy status: ${meta.status} (${meta.error || ''})`);
                            if (meta.status === 'error') {
                                if (window.showToast) window.showToast(`VNC Tunnel Error: ${meta.error}`, 'error');
                                this.updateStatus('PROXY ERROR', 'disconnected');
                            }
                        }
                    } catch (e) {}
                    return;
                }

                // Append incoming binary chunk
                const chunk = new Uint8Array(evt.data);
                if (this.rxBuffer.length === 0) {
                    this.rxBuffer = chunk;
                } else {
                    const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
                    merged.set(this.rxBuffer, 0);
                    merged.set(chunk, this.rxBuffer.length);
                    this.rxBuffer = merged;
                }

                this.processRxBuffer();
            };

            this.ws.onclose = () => {
                this.log('VNC WebSocket connection closed.');
                this.onDisconnected();
            };

            this.ws.onerror = (err) => {
                this.log('WebSocket network error.');
                this.onDisconnected();
            };

        } catch (e) {
            this.log(`Connection failed: ${e.message}`);
            this.onDisconnected();
        }
    }

    disconnect() {
        if (this.nextFrameTimer) {
            clearTimeout(this.nextFrameTimer);
            this.nextFrameTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.authModal) {
            this.authModal.style.display = 'none';
        }
        this.rxBuffer = new Uint8Array(0);
        this.rfbState = 0;
        this.pendingChallenge = null;
        this.onDisconnected();
    }

    onConnected() {
        this.isConnected = true;
        this.updateStatus('CONNECTED', 'connected');
        if (this.overlay) this.overlay.classList.add('hidden');
        if (this.connectBtn) this.connectBtn.style.display = 'none';
        if (this.disconnectBtn) this.disconnectBtn.style.display = 'inline-flex';
        this.updateCanvasScaling();
        if (this.canvas) this.canvas.focus();
    }

    onDisconnected() {
        if (this.nextFrameTimer) {
            clearTimeout(this.nextFrameTimer);
            this.nextFrameTimer = null;
        }
        this.isConnected = false;
        this.updateStatus('DISCONNECTED', 'disconnected');
        if (this.overlay) this.overlay.classList.remove('hidden');
        if (this.connectBtn) this.connectBtn.style.display = 'inline-flex';
        if (this.disconnectBtn) this.disconnectBtn.style.display = 'none';
    }

    updateStatus(statusStr, state) {
        if (this.statusText) this.statusText.textContent = statusStr;
        if (this.statusDot) {
            this.statusDot.className = 'pulse-dot';
            if (state === 'connected') {
                this.statusDot.style.backgroundColor = 'var(--accent-green)';
            } else if (state === 'warning') {
                this.statusDot.style.backgroundColor = 'var(--accent-amber)';
            } else {
                this.statusDot.classList.add('disconnected');
            }
        }
    }

    updateCanvasScaling() {
        if (!this.canvas) return;
        this.canvas.className = '';
        if (this.scaleMode === 'fit') {
            this.canvas.classList.add('scaled-fit');
        } else if (this.scaleMode === 'stretch') {
            this.canvas.classList.add('scaled-stretch');
        }
    }

    // ── RFB Protocol State Machine ─────────────────────────────────────────

    processRxBuffer() {
        while (this.rxBuffer.length > 0) {
            if (this.rfbState === 0) {
                // Stage 0: Version negotiation (12 bytes, e.g. "RFB 003.008\n")
                if (this.rxBuffer.length < 12) return;
                const verStr = new TextDecoder().decode(this.rxBuffer.subarray(0, 12));
                this.rxBuffer = this.rxBuffer.subarray(12);

                if (verStr.startsWith('RFB')) {
                    this.log(`Server RFB Version: ${verStr.trim()}`);
                    const reply = new TextEncoder().encode('RFB 003.008\n');
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(reply);
                    }
                    this.rfbState = 1; // Security negotiation
                } else {
                    this.log(`Unexpected RFB banner: ${verStr}`);
                    this.disconnect();
                    return;
                }

            } else if (this.rfbState === 1) {
                // Stage 1: Security Types (1 byte count, followed by N bytes of types)
                if (this.rxBuffer.length < 1) return;
                const count = this.rxBuffer[0];
                if (count === 0) {
                    // Failure reason string
                    if (this.rxBuffer.length < 5) return;
                    const reasonLen = new DataView(this.rxBuffer.buffer, this.rxBuffer.byteOffset).getUint32(1, false);
                    if (this.rxBuffer.length < 5 + reasonLen) return;
                    const reason = new TextDecoder().decode(this.rxBuffer.subarray(5, 5 + reasonLen));
                    this.log(`RFB Rejected: ${reason}`);
                    if (window.showToast) window.showToast(`VNC Error: ${reason}`, 'error');
                    this.disconnect();
                    return;
                }
                if (this.rxBuffer.length < 1 + count) return;

                const types = [];
                for (let i = 1; i <= count; i++) {
                    types.push(this.rxBuffer[i]);
                }
                this.rxBuffer = this.rxBuffer.subarray(1 + count);

                this.log(`Server security types offered: [${types.join(', ')}]`);

                // Prefer None (1), then VNCAuth (2)
                let chosenType = 1;
                if (types.includes(1)) {
                    chosenType = 1; // No authentication required!
                } else if (types.includes(2)) {
                    chosenType = 2; // VNC password auth required
                } else {
                    chosenType = types[0];
                }

                this.log(`Selected security type: ${chosenType} (${chosenType === 1 ? 'None' : 'VNCAuth'})`);
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(new Uint8Array([chosenType]));
                }

                if (chosenType === 1) {
                    this.rfbState = 3; // Expect SecurityResult uint32
                } else if (chosenType === 2) {
                    this.rfbState = 2; // Expect 16-byte challenge
                } else {
                    this.log(`Unsupported security type: ${chosenType}`);
                    this.disconnect();
                    return;
                }

            } else if (this.rfbState === 2) {
                // Stage 2: VNC Authentication Challenge (16 bytes random challenge)
                if (this.rxBuffer.length < 16) return;
                this.pendingChallenge = new Uint8Array(this.rxBuffer.subarray(0, 16));
                this.rxBuffer = this.rxBuffer.subarray(16);

                const currentPass = this.passInput ? this.passInput.value : '';
                if (currentPass) {
                    this.sendAuthResponse(currentPass);
                } else {
                    // Prompt user with in-canvas modal
                    if (this.authModal) {
                        this.authModal.style.display = 'flex';
                        if (this.authModalPass) {
                            this.authModalPass.value = '';
                            this.authModalPass.focus();
                        }
                    }
                }
                return;

            } else if (this.rfbState === 3) {
                // Stage 3: SecurityResult (4 bytes uint32: 0 = OK)
                if (this.rxBuffer.length < 4) return;
                const res = new DataView(this.rxBuffer.buffer, this.rxBuffer.byteOffset).getUint32(0, false);
                this.rxBuffer = this.rxBuffer.subarray(4);

                if (res === 0) {
                    this.log('Security handshake OK. Sending ClientInit (Shared = 1)...');
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(new Uint8Array([1])); // shared-flag = 1
                    }
                    this.rfbState = 4; // Expect ServerInit
                } else {
                    this.log(`VNC Authentication Failed (Result: ${res})`);
                    if (window.showToast) window.showToast('VNC Authentication Failed! Check password.', 'error');
                    this.disconnect();
                    return;
                }

            } else if (this.rfbState === 4) {
                // Stage 4: ServerInit message
                if (this.rxBuffer.length < 24) return;
                const view = new DataView(this.rxBuffer.buffer, this.rxBuffer.byteOffset);
                const nameLen = view.getUint32(20, false);
                if (this.rxBuffer.length < 24 + nameLen) return;

                this.width = view.getUint16(0, false);
                this.height = view.getUint16(2, false);
                this.bitsPerPixel = view.getUint8(4);
                this.depth = view.getUint8(5);
                this.bigEndian = view.getUint8(6);
                this.trueColor = view.getUint8(7);
                this.redMax = view.getUint16(8, false);
                this.greenMax = view.getUint16(10, false);
                this.blueMax = view.getUint16(12, false);
                this.redShift = view.getUint8(14);
                this.greenShift = view.getUint8(15);
                this.blueShift = view.getUint8(16);

                const nameBytes = this.rxBuffer.slice(24, 24 + nameLen);
                this.desktopName = new TextDecoder().decode(nameBytes);
                this.rxBuffer = this.rxBuffer.subarray(24 + nameLen);

                this.log(`Server Desktop Init: ${this.width}×${this.height} ("${this.desktopName}") bpp=${this.bitsPerPixel} depth=${this.depth}`);

                if (this.canvas) {
                    this.canvas.width = this.width;
                    this.canvas.height = this.height;
                }
                if (this.resBadge) {
                    this.resBadge.textContent = `${this.width}×${this.height}`;
                }

                this.rfbState = 5; // Connected & streaming
                this.onConnected();

                // Send encodings: Raw (0), DesktopSize (-223)
                this.sendSetEncodings();
                // Request initial full framebuffer update
                this.requestFramebufferUpdate(0, 0, 0, this.width, this.height);

            } else if (this.rfbState === 5) {
                // Stage 5: Framebuffer Updates and server notifications
                if (this.rxBuffer.length < 1) return;
                const msgType = this.rxBuffer[0];

                if (msgType === 0) {
                    // FramebufferUpdate
                    if (this.rxBuffer.length < 4) return;
                    const view = new DataView(this.rxBuffer.buffer, this.rxBuffer.byteOffset, this.rxBuffer.byteLength);
                    const numRects = view.getUint16(2, false);

                    let scanOffset = 4;
                    let complete = true;
                    const bytesPerPixel = this.bitsPerPixel ? Math.floor(this.bitsPerPixel / 8) : 4;

                    for (let r = 0; r < numRects; r++) {
                        if (scanOffset + 12 > this.rxBuffer.length) {
                            complete = false;
                            break;
                        }
                        const rw = view.getUint16(scanOffset + 4, false);
                        const rh = view.getUint16(scanOffset + 6, false);
                        const enc = view.getInt32(scanOffset + 8, false);
                        scanOffset += 12;

                        if (enc === 0) { // Raw
                            const pixelBytes = rw * rh * bytesPerPixel;
                            if (scanOffset + pixelBytes > this.rxBuffer.length) {
                                complete = false;
                                break;
                            }
                            scanOffset += pixelBytes;
                        } else if (enc === 1) { // CopyRect
                            if (scanOffset + 4 > this.rxBuffer.length) {
                                complete = false;
                                break;
                            }
                            scanOffset += 4;
                        } else if (enc === -223) { // DesktopSize
                            // No pixel payload
                        }
                    }

                    if (!complete) {
                        // Wait for remaining chunks
                        return;
                    }

                    // Render all rectangles in complete frame
                    let renderOffset = 4;
                    for (let r = 0; r < numRects; r++) {
                        const rx = view.getUint16(renderOffset, false);
                        const ry = view.getUint16(renderOffset + 2, false);
                        const rw = view.getUint16(renderOffset + 4, false);
                        const rh = view.getUint16(renderOffset + 6, false);
                        const enc = view.getInt32(renderOffset + 8, false);
                        renderOffset += 12;

                        if (enc === 0) {
                            const pixelBytes = rw * rh * bytesPerPixel;
                            const rawPixels = this.rxBuffer.subarray(renderOffset, renderOffset + pixelBytes);
                            this.renderRawPixels(rx, ry, rw, rh, rawPixels);
                            renderOffset += pixelBytes;
                        } else if (enc === 1) {
                            const srcX = view.getUint16(renderOffset, false);
                            const srcY = view.getUint16(renderOffset + 2, false);
                            renderOffset += 4;
                            if (this.ctx && rw > 0 && rh > 0) {
                                try {
                                    const copy = this.ctx.getImageData(srcX, srcY, rw, rh);
                                    this.ctx.putImageData(copy, rx, ry);
                                } catch (e) {}
                            }
                        } else if (enc === -223) {
                            this.width = rw;
                            this.height = rh;
                            if (this.canvas) {
                                this.canvas.width = rw;
                                this.canvas.height = rh;
                            }
                            if (this.resBadge) {
                                this.resBadge.textContent = `${rw}×${rh}`;
                            }
                        }
                    }

                    this.frameCount++;
                    this.rxBuffer = this.rxBuffer.subarray(renderOffset);

                    // Clean buffer fragmentation if offset is large
                    if (this.rxBuffer.byteOffset > 1048576) {
                        this.rxBuffer = new Uint8Array(this.rxBuffer);
                    }

                    // Schedule next incremental update
                    if (this.nextFrameTimer) clearTimeout(this.nextFrameTimer);
                    this.nextFrameTimer = setTimeout(() => {
                        if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                            this.requestFramebufferUpdate(1, 0, 0, this.width, this.height);
                        }
                    }, 25);

                } else if (msgType === 1) {
                    // SetColourMapEntries: 6 + numColours * 6
                    if (this.rxBuffer.length < 6) return;
                    const view = new DataView(this.rxBuffer.buffer, this.rxBuffer.byteOffset);
                    const count = view.getUint16(4, false);
                    const len = 6 + count * 6;
                    if (this.rxBuffer.length < len) return;
                    this.rxBuffer = this.rxBuffer.subarray(len);
                } else if (msgType === 2) {
                    // Bell: 1 byte
                    this.rxBuffer = this.rxBuffer.subarray(1);
                } else if (msgType === 3) {
                    // ServerCutText: 8 + len
                    if (this.rxBuffer.length < 8) return;
                    const view = new DataView(this.rxBuffer.buffer, this.rxBuffer.byteOffset);
                    const txtLen = view.getUint32(4, false);
                    if (this.rxBuffer.length < 8 + txtLen) return;
                    const textBytes = this.rxBuffer.subarray(8, 8 + txtLen);
                    const text = new TextDecoder().decode(textBytes);
                    this.log(`Remote Clipboard: ${text.slice(0, 80)}`);
                    this.rxBuffer = this.rxBuffer.subarray(8 + txtLen);
                } else {
                    // Skip unknown 1 byte
                    this.rxBuffer = this.rxBuffer.subarray(1);
                }
            }
        }
    }

    // ── VNC Authentication (DES) Implementation ───────────────────────────

    submitAuthModal() {
        const pass = this.authModalPass ? this.authModalPass.value : '';
        if (this.authModal) this.authModal.style.display = 'none';
        if (this.passInput) this.passInput.value = pass;
        this.sendAuthResponse(pass);
    }

    sendAuthResponse(password) {
        if (!this.pendingChallenge || this.pendingChallenge.length !== 16) {
            this.log('No pending auth challenge.');
            return;
        }

        this.log('Encrypting VNC DES authentication challenge...');
        const response = this.encryptVncChallenge(this.pendingChallenge, password);
        this.pendingChallenge = null;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(response);
            this.rfbState = 3; // Expect SecurityResult
        }
    }

    encryptVncChallenge(challenge, password) {
        // Prepare 8-byte key with reversed bit-order per RFB spec
        const key = new Uint8Array(8);
        for (let i = 0; i < 8; i++) {
            if (i < password.length) {
                const b = password.charCodeAt(i);
                // Reverse bits in byte
                key[i] = ((b & 0x01) << 7) |
                         ((b & 0x02) << 5) |
                         ((b & 0x04) << 3) |
                         ((b & 0x08) << 1) |
                         ((b & 0x10) >> 1) |
                         ((b & 0x20) >> 3) |
                         ((b & 0x40) >> 5) |
                         ((b & 0x80) >> 7);
            } else {
                key[i] = 0;
            }
        }

        // Encrypt challenge in two 8-byte blocks using single DES
        const response = new Uint8Array(16);
        const b1 = this.desEncryptBlock(challenge.subarray(0, 8), key);
        const b2 = this.desEncryptBlock(challenge.subarray(8, 16), key);
        response.set(b1, 0);
        response.set(b2, 8);
        return response;
    }

    // Standard Single DES block encryption (8 bytes in, 8 bytes out)
    desEncryptBlock(block8, key8) {
        // Permutation tables
        const IP = [
            58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
            62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
            57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
            61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7
        ];
        const FP = [
            40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
            38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
            36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
            34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25
        ];
        const PC1 = [
            57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
            10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
            63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
            14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4
        ];
        const PC2 = [
            14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
            23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
            41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
            44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
        ];
        const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
        const E = [
            32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
            8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
            16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
            24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
        ];
        const P = [
            16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
            2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
        ];
        const S = [
            [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
            [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
            [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
            [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
            [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
            [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
            [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
            [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
        ];

        // Helper: get bit from Uint8Array (1-indexed)
        const getBit = (bytes, n) => {
            const byteIdx = (n - 1) >> 3;
            const bitIdx = 7 - ((n - 1) & 7);
            return (bytes[byteIdx] >> bitIdx) & 1;
        };

        // Permute bits into a bit-array
        const permute = (src, table) => {
            const out = new Uint8Array(table.length);
            for (let i = 0; i < table.length; i++) {
                out[i] = getBit(src, table[i]);
            }
            return out;
        };

        // Key Schedule
        const keyBits = permute(key8, PC1);
        let C = keyBits.subarray(0, 28);
        let D = keyBits.subarray(28, 56);
        const subkeys = [];

        const rotateLeft = (arr, n) => {
            const res = new Uint8Array(arr.length);
            for (let i = 0; i < arr.length; i++) {
                res[i] = arr[(i + n) % arr.length];
            }
            return res;
        };

        for (let r = 0; r < 16; r++) {
            C = rotateLeft(C, SHIFTS[r]);
            D = rotateLeft(D, SHIFTS[r]);
            const CD = new Uint8Array(56);
            CD.set(C, 0);
            CD.set(D, 28);
            const K = new Uint8Array(48);
            for (let i = 0; i < 48; i++) {
                K[i] = CD[PC2[i] - 1];
            }
            subkeys.push(K);
        }

        // Encrypt data block
        const initBits = permute(block8, IP);
        let L = initBits.subarray(0, 32);
        let R = initBits.subarray(32, 64);

        for (let r = 0; r < 16; r++) {
            const nextL = R;
            // Expansion E
            const ER = new Uint8Array(48);
            for (let i = 0; i < 48; i++) {
                ER[i] = R[E[i] - 1] ^ subkeys[r][i];
            }
            // S-boxes
            const sOut = new Uint8Array(32);
            for (let b = 0; b < 8; b++) {
                const off = b * 6;
                const row = (ER[off] << 1) | ER[off + 5];
                const col = (ER[off + 1] << 3) | (ER[off + 2] << 2) | (ER[off + 3] << 1) | ER[off + 4];
                const val = S[b][(row * 16) + col] || 0;
                sOut[b * 4]     = (val >> 3) & 1;
                sOut[b * 4 + 1] = (val >> 2) & 1;
                sOut[b * 4 + 2] = (val >> 1) & 1;
                sOut[b * 4 + 3] = val & 1;
            }
            // Permutation P
            const fOut = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                fOut[i] = sOut[P[i] - 1];
            }
            // XOR with L
            const nextR = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                nextR[i] = L[i] ^ fOut[i];
            }
            L = nextL;
            R = nextR;
        }

        // Final permutation
        const preFP = new Uint8Array(64);
        preFP.set(R, 0);
        preFP.set(L, 32);

        const outBytes = new Uint8Array(8);
        for (let i = 0; i < 64; i++) {
            const bit = preFP[FP[i] - 1];
            if (bit) {
                outBytes[i >> 3] |= (1 << (7 - (i & 7)));
            }
        }
        return outBytes;
    }

    // ── Pixel Rendering ───────────────────────────────────────────────────

    renderRawPixels(x, y, w, h, pixelData) {
        if (!this.ctx || w <= 0 || h <= 0) return;
        try {
            const imgData = this.ctx.createImageData(w, h);
            const data = imgData.data;

            if (this.redShift === 0) {
                // RGBA
                for (let i = 0; i < pixelData.length; i += 4) {
                    data[i]     = pixelData[i];     // R
                    data[i + 1] = pixelData[i + 1]; // G
                    data[i + 2] = pixelData[i + 2]; // B
                    data[i + 3] = 255;              // A
                }
            } else {
                // BGRx (standard for x11vnc with redShift=16, blueShift=0)
                for (let i = 0; i < pixelData.length; i += 4) {
                    data[i]     = pixelData[i + 2]; // R
                    data[i + 1] = pixelData[i + 1]; // G
                    data[i + 2] = pixelData[i];     // B
                    data[i + 3] = 255;              // A
                }
            }
            this.ctx.putImageData(imgData, x, y);
        } catch (err) {
            console.error('[VNC Pixel Render Error]', err);
        }
    }

    sendSetEncodings() {
        const count = 2;
        const msg = new Uint8Array(4 + count * 4);
        const view = new DataView(msg.buffer);
        view.setUint8(0, 2); // SetEncodings
        view.setUint16(2, count, false);
        view.setInt32(4, 0, false);     // Raw (0)
        view.setInt32(8, -223, false);  // DesktopSize (-223)
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        }
    }

    requestFramebufferUpdate(incremental, x, y, w, h) {
        const msg = new Uint8Array(10);
        const view = new DataView(msg.buffer);
        view.setUint8(0, 3); // FramebufferUpdateRequest
        view.setUint8(1, incremental ? 1 : 0);
        view.setUint16(2, x, false);
        view.setUint16(4, y, false);
        view.setUint16(6, w, false);
        view.setUint16(8, h, false);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        }
    }

    // ── Mouse & Keyboard Input ────────────────────────────────────────────

    getCanvasCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        return {
            x: Math.max(0, Math.min(this.width, x)),
            y: Math.max(0, Math.min(this.height, y))
        };
    }

    handlePointerEvent(e, type) {
        if (!this.canvas) return;
        const pos = this.getCanvasCoordinates(e);

        if (type === 'down') {
            if (e.button === 0) this.buttonMask |= 1;  // Left
            if (e.button === 1) this.buttonMask |= 2;  // Middle
            if (e.button === 2) this.buttonMask |= 4;  // Right
        } else if (type === 'up') {
            if (e.button === 0) this.buttonMask &= ~1;
            if (e.button === 1) this.buttonMask &= ~2;
            if (e.button === 2) this.buttonMask &= ~4;
        }

        if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = new Uint8Array(6);
            const view = new DataView(msg.buffer);
            view.setUint8(0, 5); // PointerEvent
            view.setUint8(1, this.buttonMask);
            view.setUint16(2, pos.x, false);
            view.setUint16(4, pos.y, false);
            this.ws.send(msg);

            if (type === 'down' || type === 'up') {
                setTimeout(() => {
                    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.requestFramebufferUpdate(1, 0, 0, this.width, this.height);
                    }
                }, 20);
            }
        }
    }

    handleWheelEvent(e) {
        e.preventDefault();
        const pos = this.getCanvasCoordinates(e);
        const mask = (e.deltaY < 0) ? 8 : 16; // Button 4 (scroll up) or Button 5 (scroll down)

        if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Send button down
            const down = new Uint8Array(6);
            const v1 = new DataView(down.buffer);
            v1.setUint8(0, 5);
            v1.setUint8(1, this.buttonMask | mask);
            v1.setUint16(2, pos.x, false);
            v1.setUint16(4, pos.y, false);
            this.ws.send(down);

            // Send button up
            const up = new Uint8Array(6);
            const v2 = new DataView(up.buffer);
            v2.setUint8(0, 5);
            v2.setUint8(1, this.buttonMask);
            v2.setUint16(2, pos.x, false);
            v2.setUint16(4, pos.y, false);
            this.ws.send(up);

            setTimeout(() => {
                if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.requestFramebufferUpdate(1, 0, 0, this.width, this.height);
                }
            }, 30);
        }
    }

    handleKeyEvent(e, down) {
        if (!this.isConnected) return;
        e.preventDefault();

        const keysym = this.domKeyToKeysym(e);
        if (keysym && this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = new Uint8Array(8);
            const view = new DataView(msg.buffer);
            view.setUint8(0, 4); // KeyEvent
            view.setUint8(1, down ? 1 : 0);
            view.setUint32(4, keysym, false);
            this.ws.send(msg);

            if (down) {
                setTimeout(() => {
                    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.requestFramebufferUpdate(1, 0, 0, this.width, this.height);
                    }
                }, 30);
            }
        }
    }

    domKeyToKeysym(e) {
        const special = {
            'Backspace':  0xFF08,
            'Tab':        0xFF09,
            'Enter':      0xFF0D,
            'Escape':     0xFF1B,
            'Insert':     0xFF63,
            'Delete':     0xFFFF,
            'Home':       0xFF50,
            'End':        0xFF57,
            'PageUp':     0xFF55,
            'PageDown':   0xFF56,
            'ArrowLeft':  0xFF51,
            'ArrowUp':    0xFF52,
            'ArrowRight': 0xFF53,
            'ArrowDown':  0xFF54,
            'F1':         0xFFBE,
            'F2':         0xFFBF,
            'F3':         0xFFC0,
            'F4':         0xFFC1,
            'F5':         0xFFC2,
            'F6':         0xFFC3,
            'F7':         0xFFC4,
            'F8':         0xFFC5,
            'F9':         0xFFC6,
            'F10':        0xFFC7,
            'F11':        0xFFC8,
            'F12':        0xFFC9,
            'Shift':      0xFFE1,
            'Control':    0xFFE3,
            'Meta':       0xFFEB,
            'Alt':        0xFFE9,
            'CapsLock':   0xFFE5,
        };

        if (special[e.key]) return special[e.key];
        if (e.key.length === 1) {
            const code = e.key.charCodeAt(0);
            if (code >= 32 && code <= 126) return code;
        }
        return e.keyCode || 0;
    }

    sendSingleKey(keysym) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        // Key down
        const down = new Uint8Array(8);
        const v1 = new DataView(down.buffer);
        v1.setUint8(0, 4);
        v1.setUint8(1, 1);
        v1.setUint32(4, keysym, false);
        this.ws.send(down);

        // Key up
        setTimeout(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const up = new Uint8Array(8);
            const v2 = new DataView(up.buffer);
            v2.setUint8(0, 4);
            v2.setUint8(1, 0);
            v2.setUint32(4, keysym, false);
            this.ws.send(up);
        }, 50);
    }

    sendMacro(macroName) {
        if (!this.isConnected) {
            if (window.showToast) window.showToast('Connect to remote desktop first.', 'warning');
            return;
        }

        const VK_CTRL  = 0xFFE3;
        const VK_ALT   = 0xFFE9;
        const VK_DEL   = 0xFFFF;
        const VK_TAB   = 0xFF09;
        const VK_SUPER = 0xFFEB;
        const VK_ESC   = 0xFF1B;
        const VK_C     = 0x0063;
        const VK_V     = 0x0076;

        const sendKeyDirect = (sym, isDown) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const msg = new Uint8Array(8);
            const v = new DataView(msg.buffer);
            v.setUint8(0, 4);
            v.setUint8(1, isDown ? 1 : 0);
            v.setUint32(4, sym, false);
            this.ws.send(msg);
        };

        if (macroName === 'CAD') {
            this.log('Sending macro: Ctrl+Alt+Del');
            sendKeyDirect(VK_CTRL, true);
            sendKeyDirect(VK_ALT, true);
            sendKeyDirect(VK_DEL, true);
            setTimeout(() => {
                sendKeyDirect(VK_DEL, false);
                sendKeyDirect(VK_ALT, false);
                sendKeyDirect(VK_CTRL, false);
                this.requestFramebufferUpdate(1, 0, 0, this.width, this.height);
            }, 100);
        } else if (macroName === 'ALTTAB') {
            this.log('Sending macro: Alt+Tab');
            sendKeyDirect(VK_ALT, true);
            sendKeyDirect(VK_TAB, true);
            setTimeout(() => {
                sendKeyDirect(VK_TAB, false);
                sendKeyDirect(VK_ALT, false);
                this.requestFramebufferUpdate(1, 0, 0, this.width, this.height);
            }, 100);
        } else if (macroName === 'SUPER') {
            this.log('Sending macro: Super key');
            this.sendSingleKey(VK_SUPER);
        } else if (macroName === 'ESC') {
            this.log('Sending macro: Escape');
            this.sendSingleKey(VK_ESC);
        } else if (macroName === 'CTRL_C') {
            this.log('Sending macro: Ctrl+C');
            sendKeyDirect(VK_CTRL, true);
            sendKeyDirect(VK_C, true);
            setTimeout(() => {
                sendKeyDirect(VK_C, false);
                sendKeyDirect(VK_CTRL, false);
            }, 80);
        } else if (macroName === 'CTRL_V') {
            this.log('Sending macro: Ctrl+V');
            sendKeyDirect(VK_CTRL, true);
            sendKeyDirect(VK_V, true);
            setTimeout(() => {
                sendKeyDirect(VK_V, false);
                sendKeyDirect(VK_CTRL, false);
            }, 80);
        }
    }

    sendText(str) {
        if (!this.isConnected || !str) return;
        this.log(`Sending text sequence (${str.length} chars)...`);

        let delay = 0;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            setTimeout(() => {
                this.sendSingleKey(ch);
            }, delay);
            delay += 25;
        }

        setTimeout(() => {
            this.requestFramebufferUpdate(1, 0, 0, this.width, this.height);
        }, delay + 50);
    }
}

// Instantiate and attach globally
document.addEventListener('DOMContentLoaded', () => {
    window.vncMgr = new PulseOpsVNCManager();
});
