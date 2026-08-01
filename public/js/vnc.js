/* ==========================================================================
   PulseOps - VNC Remote Desktop Manager & RFB Client Engine
   ========================================================================== */

class PulseOpsVNCManager {
    constructor() {
        this.ws = null;
        this.canvas = null;
        this.ctx = null;
        this.isConnected = false;
        this.isDemoMode = false;
        this.rfbState = 0; // 0: Init, 1: Version, 2: Security, 3: SecurityResult, 4: ServerInit, 5: Connected
        
        this.width = 1280;
        this.height = 800;
        this.desktopName = 'PulseOps Remote Session';
        this.fps = 0;
        this.frameCount = 0;
        this.lastFpsCalc = Date.now();

        // Canvas scaling mode: 'fit', '1:1', 'stretch'
        this.scaleMode = 'fit';

        // Mouse button state tracking
        this.buttonMask = 0;

        // Demo desktop simulator state
        this.demoState = null;
        this.demoAnimId = null;

        this.initElements();
        this.initEvents();
        this.checkHostVncStatus();
    }

    initElements() {
        this.canvas = document.getElementById('vnc-canvas');
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d');
        }

        this.hostInput = document.getElementById('vnc-host-input');
        this.portInput = document.getElementById('vnc-port-input');
        this.passInput = document.getElementById('vnc-pass-input');
        
        this.connectBtn = document.getElementById('vnc-connect-btn');
        this.disconnectBtn = document.getElementById('vnc-disconnect-btn');
        this.statusDot = document.getElementById('vnc-dot');
        this.statusText = document.getElementById('vnc-status-text');
        this.overlay = document.getElementById('vnc-overlay');
        this.serverInfoBox = document.getElementById('vnc-server-info');
        this.consoleOut = document.getElementById('vnc-console-output');
        this.fpsIndicator = document.getElementById('vnc-fps-indicator');
        this.resBadge = document.getElementById('vnc-res-badge');
    }

    initEvents() {
        // Connection buttons
        if (this.connectBtn) this.connectBtn.addEventListener('click', () => this.connect());
        if (this.disconnectBtn) this.disconnectBtn.addEventListener('click', () => this.disconnect());

        // Overlay buttons
        const ovConnect = document.getElementById('vnc-overlay-connect-btn');
        const ovLaunch = document.getElementById('vnc-overlay-launch-btn');
        const ovDemo = document.getElementById('vnc-overlay-demo-btn');

        if (ovConnect) ovConnect.addEventListener('click', () => this.connect());
        if (ovLaunch) ovLaunch.addEventListener('click', () => this.launchHostDaemon());
        if (ovDemo) ovDemo.addEventListener('click', () => this.startDemoMode());

        const demoToggle = document.getElementById('vnc-demo-toggle-btn');
        if (demoToggle) demoToggle.addEventListener('click', () => {
            if (this.isDemoMode) {
                this.stopDemoMode();
            } else {
                this.startDemoMode();
            }
        });

        // Display scaling select
        const scaleSelect = document.getElementById('vnc-scale-select');
        if (scaleSelect) {
            scaleSelect.addEventListener('change', (e) => {
                this.scaleMode = e.target.value;
                this.updateCanvasScaling();
            });
        }

        // Fullscreen button
        const fsBtn = document.getElementById('vnc-fullscreen-btn');
        if (fsBtn) {
            fsBtn.addEventListener('click', () => {
                const container = document.getElementById('vnc-viewport-container');
                if (container) {
                    if (!document.fullscreenElement) {
                        container.requestFullscreen().catch(err => {
                            this.log(`Fullscreen error: ${err.message}`);
                        });
                    } else {
                        document.exitFullscreen();
                    }
                }
            });
        }

        // Quick Macro buttons
        const cadBtn = document.getElementById('vnc-btn-cad');
        const altTabBtn = document.getElementById('vnc-btn-alttab');
        const superBtn = document.getElementById('vnc-btn-super');
        const escBtn = document.getElementById('vnc-btn-esc');

        if (cadBtn) cadBtn.addEventListener('click', () => this.sendMacro('CAD'));
        if (altTabBtn) altTabBtn.addEventListener('click', () => this.sendMacro('ALTTAB'));
        if (superBtn) superBtn.addEventListener('click', () => this.sendMacro('SUPER'));
        if (escBtn) escBtn.addEventListener('click', () => this.sendMacro('ESC'));

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

        // Canvas Mouse & Pointer Event Listeners
        if (this.canvas) {
            this.canvas.addEventListener('mousemove', (e) => this.handlePointerEvent(e, 'move'));
            this.canvas.addEventListener('mousedown', (e) => this.handlePointerEvent(e, 'down'));
            this.canvas.addEventListener('mouseup', (e) => this.handlePointerEvent(e, 'up'));
            this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            this.canvas.addEventListener('wheel', (e) => this.handleWheelEvent(e));

            // Keyboard capturing when canvas is focused/clicked
            this.canvas.setAttribute('tabindex', '0');
            this.canvas.addEventListener('keydown', (e) => this.handleKeyEvent(e, true));
            this.canvas.addEventListener('keyup', (e) => this.handleKeyEvent(e, false));
        }

        // FPS Counter Timer
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
        console.log(`[PulseOps VNC] ${msg}`);
    }

    async checkHostVncStatus() {
        try {
            const host = this.hostInput ? this.hostInput.value : '127.0.0.1';
            const res = await fetch(`/api/vnc/status?host=${host}`);
            const data = await res.json();

            if (this.serverInfoBox) {
                if (data.running) {
                    this.serverInfoBox.innerHTML = `
                        <span style="color: var(--accent-green);">✓ Active VNC Server listening on ${data.host}:${data.defaultPort}</span><br>
                        Open ports: <strong>${data.openPorts.join(', ')}</strong> | Display: <code>${data.display}</code>
                    `;
                    if (this.portInput) this.portInput.value = data.defaultPort;
                } else {
                    const bins = data.installedBinaries.length > 0 ? data.installedBinaries.join(', ') : 'None installed';
                    this.serverInfoBox.innerHTML = `
                        <span style="color: var(--accent-amber);">ℹ Host VNC Status: No daemon running on 5900-5905</span><br>
                        Installed binaries: <code>${bins}</code> | <em>Click "Detect & Start VNC Server" to launch built-in service!</em><br>
                        <span style="font-size: 0.75rem; color: var(--text-dim);">To mirror physical X11 desktop, run: <code>sudo apt update && sudo apt install -y x11vnc</code></span>
                    `;
                }
            }
        } catch (e) {
            if (this.serverInfoBox) {
                this.serverInfoBox.textContent = 'Unable to query host VNC server status.';
            }
        }
    }

    async launchHostDaemon() {
        this.log('Attempting to start VNC server daemon...');
        try {
            const res = await fetch('/api/vnc/launch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    port: parseInt(this.portInput ? this.portInput.value : 5900, 10),
                    display: ':0'
                })
            });
            const data = await res.json();
            if (data.success) {
                if (window.showToast) window.showToast(data.message, 'success');
                this.log(data.message);
                setTimeout(() => {
                    this.checkHostVncStatus();
                    this.connect(); // Auto connect to the newly started VNC server!
                }, 800);
            } else {
                if (window.showToast) window.showToast(data.error || data.message, 'error');
                this.log(`Launch info: ${data.error || data.message}`);
            }
        } catch (e) {
            if (window.showToast) window.showToast(`Launch failed: ${e.message}`, 'error');
        }
    }

    connect() {
        if (this.isDemoMode) {
            this.stopDemoMode();
        }

        const host = this.hostInput ? this.hostInput.value.trim() : '127.0.0.1';
        const port = this.portInput ? this.portInput.value.trim() : '5900';

        this.log(`Connecting to VNC WebSocket proxy (Target: ${host}:${port})...`);
        this.updateStatus('CONNECTING', 'warning');

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/vnc/ws?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;

        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                this.log('WebSocket proxy tunnel established. Initiating RFB handshake...');
                this.rfbState = 0;
            };

            this.ws.onmessage = (evt) => {
                if (typeof evt.data === 'string') {
                    try {
                        const meta = JSON.parse(evt.data);
                        if (meta.type === 'vnc_proxy_meta') {
                            this.log(`Proxy status: ${meta.status} (${meta.message || ''})`);
                        }
                    } catch (e) {}
                    return;
                }

                // Handle binary RFB stream
                this.handleRfbData(new Uint8Array(evt.data));
            };

            this.ws.onclose = () => {
                this.log('VNC WebSocket connection closed.');
                this.onDisconnected();
            };

            this.ws.onerror = (err) => {
                this.log('WebSocket error encountered.');
                this.onDisconnected();
            };

        } catch (e) {
            this.log(`Connection failed: ${e.message}`);
            this.onDisconnected();
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.isDemoMode) {
            this.stopDemoMode();
        }
        this.onDisconnected();
    }

    onConnected() {
        this.isConnected = true;
        this.updateStatus('CONNECTED', 'connected');
        if (this.overlay) this.overlay.classList.add('hidden');
        if (this.connectBtn) this.connectBtn.style.display = 'none';
        if (this.disconnectBtn) this.disconnectBtn.style.display = 'inline-flex';
        this.updateCanvasScaling();
    }

    onDisconnected() {
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

    // -------------------------------------------------------------
    // RFB (Remote Frame Buffer) Binary Protocol Engine
    // -------------------------------------------------------------

    handleRfbData(buf) {
        this.frameCount++;
        
        // RFB Protocol Handshake State Machine
        if (this.rfbState === 0) {
            // Stage 0: Expect Server Version (e.g. "RFB 003.008\n")
            const verStr = new TextDecoder().decode(buf.subarray(0, 12));
            if (verStr.startsWith('RFB')) {
                this.log(`Received Server RFB Version: ${verStr.trim()}`);
                // Send response Version string "RFB 003.008\n"
                const reply = new TextEncoder().encode('RFB 003.008\n');
                this.ws.send(reply);
                this.rfbState = 1; // Security negotiation stage
            }
            return;
        }

        if (this.rfbState === 1) {
            // Stage 1: Security Types (1 byte count, then list of types)
            const count = buf[0];
            this.log(`Server offered ${count} security type(s).`);
            
            // Select Security Type 1 (None) or 2 (VNC Auth)
            let chosenType = 1;
            if (count > 0 && buf.length >= count + 1) {
                for (let i = 1; i <= count; i++) {
                    if (buf[i] === 1) { chosenType = 1; break; }
                    if (buf[i] === 2) { chosenType = 2; break; }
                }
            }

            // Send 1 byte chosen security type
            this.ws.send(new Uint8Array([chosenType]));
            if (chosenType === 1) {
                this.rfbState = 3; // SecurityResult expected
            } else {
                this.rfbState = 2; // Auth expected
            }
            return;
        }

        if (this.rfbState === 3 || this.rfbState === 2) {
            // SecurityResult (4 bytes uint32: 0 = OK)
            this.log('Security handshake succeeded. Sending ClientInit (Shared = 1)...');
            // ClientInit: 1 byte shared flag = 1
            this.ws.send(new Uint8Array([1]));
            this.rfbState = 4; // ServerInit expected
            return;
        }

        if (this.rfbState === 4) {
            // ServerInit Message: Width (2 bytes), Height (2 bytes), PixelFormat (16 bytes), NameLength (4 bytes), Name
            if (buf.length >= 24) {
                const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                this.width = view.getUint16(0, false);
                this.height = view.getUint16(2, false);

                const nameLen = view.getUint32(20, false);
                if (buf.length >= 24 + nameLen) {
                    const nameBytes = buf.slice(24, 24 + nameLen);
                    this.desktopName = new TextDecoder().decode(nameBytes);
                }

                this.log(`Server Desktop Init: ${this.width}x${this.height} ("${this.desktopName}")`);
                
                if (this.canvas) {
                    this.canvas.width = this.width;
                    this.canvas.height = this.height;
                }

                if (this.resBadge) {
                    this.resBadge.textContent = `Res: ${this.width}x${this.height}`;
                }

                this.rfbState = 5; // Connected & Operational
                this.onConnected();

                // Send SetEncodings (Raw: 0, DesktopSize: -223)
                this.sendSetEncodings();
                // Request first full FramebufferUpdate
                this.requestFramebufferUpdate(0, 0, 0, this.width, this.height);
            }
            return;
        }

        if (this.rfbState === 5) {
            // Stage 5: Receiving FramebufferUpdate messages
            this.parseFramebufferUpdate(buf);
        }
    }

    sendSetEncodings() {
        // SetEncodings message: msgType 2 (1 byte), padding (1 byte), count uint16 (2 bytes), encodings (4 bytes each)
        const count = 2;
        const msg = new Uint8Array(4 + count * 4);
        const view = new DataView(msg.buffer);
        view.setUint8(0, 2); // SetEncodings
        view.setUint16(2, count, false);
        view.setInt32(4, 0, false); // Raw encoding (0)
        view.setInt32(8, -223, false); // DesktopSize pseudo-encoding (-223)
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        }
    }

    requestFramebufferUpdate(incremental, x, y, w, h) {
        // FramebufferUpdateRequest: msgType 3 (1 byte), incremental (1 byte), x (uint16), y (uint16), w (uint16), h (uint16)
        const msg = new Uint8Array(10);
        const view = new DataView(msg.buffer);
        view.setUint8(0, 3);
        view.setUint8(1, incremental ? 1 : 0);
        view.setUint16(2, x, false);
        view.setUint16(4, y, false);
        view.setUint16(6, w, false);
        view.setUint16(8, h, false);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        }
    }

    parseFramebufferUpdate(buf) {
        if (buf.length < 4) return;
        const msgType = buf[0];

        if (msgType === 0) {
            // FramebufferUpdate message
            const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            const numRects = view.getUint16(2, false);

            let offset = 4;
            for (let r = 0; r < numRects && offset + 12 <= buf.length; r++) {
                const rx = view.getUint16(offset, false);
                const ry = view.getUint16(offset + 2, false);
                const rw = view.getUint16(offset + 4, false);
                const rh = view.getUint16(offset + 6, false);
                const encType = view.getInt32(offset + 8, false);
                offset += 12;

                if (encType === 0) { // Raw Encoding
                    const pixelBytes = rw * rh * 4;
                    if (offset + pixelBytes <= buf.length) {
                        const rawPixels = buf.subarray(offset, offset + pixelBytes);
                        this.renderRawPixels(rx, ry, rw, rh, rawPixels);
                        offset += pixelBytes;
                    }
                } else if (encType === -223) { // DesktopSize pseudo-encoding
                    this.width = rw;
                    this.height = rh;
                    if (this.canvas) {
                        this.canvas.width = rw;
                        this.canvas.height = rh;
                    }
                }
            }

            // Request next incremental update
            setTimeout(() => {
                if (this.isConnected) {
                    this.requestFramebufferUpdate(1, 0, 0, this.width, this.height);
                }
            }, 30);
        }
    }

    renderRawPixels(x, y, w, h, pixelData) {
        if (!this.ctx) return;
        const imgData = this.ctx.createImageData(w, h);
        const data = imgData.data;

        for (let i = 0; i < pixelData.length; i += 4) {
            data[i] = pixelData[i + 2];     // Red
            data[i + 1] = pixelData[i + 1]; // Green
            data[i + 2] = pixelData[i];     // Blue
            data[i + 3] = 255;              // Alpha
        }
        this.ctx.putImageData(imgData, x, y);
    }

    // -------------------------------------------------------------
    // Mouse & Keyboard Control Actions
    // -------------------------------------------------------------

    getCanvasCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        return { x: Math.max(0, Math.min(this.width, x)), y: Math.max(0, Math.min(this.height, y)) };
    }

    handlePointerEvent(e, type) {
        if (!this.canvas) return;
        const pos = this.getCanvasCoordinates(e);

        if (type === 'down') {
            if (e.button === 0) this.buttonMask |= 1; // Left click
            if (e.button === 1) this.buttonMask |= 2; // Middle click
            if (e.button === 2) this.buttonMask |= 4; // Right click
        } else if (type === 'up') {
            if (e.button === 0) this.buttonMask &= ~1;
            if (e.button === 1) this.buttonMask &= ~2;
            if (e.button === 2) this.buttonMask &= ~4;
        }

        if (this.isDemoMode && this.demoState) {
            this.handleDemoPointer(pos.x, pos.y, type, e.button);
            return;
        }

        if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            // PointerEvent message: msgType 5 (1 byte), buttonMask (1 byte), x (uint16), y (uint16)
            const msg = new Uint8Array(6);
            const view = new DataView(msg.buffer);
            view.setUint8(0, 5);
            view.setUint8(1, this.buttonMask);
            view.setUint16(2, pos.x, false);
            view.setUint16(4, pos.y, false);
            this.ws.send(msg);
        }
    }

    handleWheelEvent(e) {
        e.preventDefault();
        const pos = this.getCanvasCoordinates(e);
        const wheelMask = e.deltaY < 0 ? 8 : 16; // Scroll up (bit 3) / down (bit 4)

        if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Send momentary wheel click down
            const msgDown = new Uint8Array(6);
            const viewDown = new DataView(msgDown.buffer);
            viewDown.setUint8(0, 5);
            viewDown.setUint8(1, this.buttonMask | wheelMask);
            viewDown.setUint16(2, pos.x, false);
            viewDown.setUint16(4, pos.y, false);
            this.ws.send(msgDown);

            // Wheel release
            const msgUp = new Uint8Array(6);
            const viewUp = new DataView(msgUp.buffer);
            viewUp.setUint8(0, 5);
            viewUp.setUint8(1, this.buttonMask);
            viewUp.setUint16(2, pos.x, false);
            viewUp.setUint16(4, pos.y, false);
            this.ws.send(msgUp);
        }
    }

    handleKeyEvent(e, isDown) {
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        // Prevent default browser shortcuts when canvas is active
        if (['Tab', 'Alt', 'Meta', 'ContextMenu'].includes(e.key)) {
            e.preventDefault();
        }

        const keySym = this.mapKeyToKeySym(e);
        if (keySym) {
            // KeyEvent message: msgType 4 (1 byte), downFlag (1 byte), padding (2 bytes), keySym (uint32)
            const msg = new Uint8Array(8);
            const view = new DataView(msg.buffer);
            view.setUint8(0, 4);
            view.setUint8(1, isDown ? 1 : 0);
            view.setUint32(4, keySym, false);
            this.ws.send(msg);
        }
    }

    mapKeyToKeySym(e) {
        const map = {
            'Backspace': 0xff08,
            'Tab': 0xff09,
            'Enter': 0xff0d,
            'Escape': 0xff1b,
            'Delete': 0xffff,
            'Home': 0xff50,
            'Left': 0xff51,
            'Up': 0xff52,
            'Right': 0xff53,
            'Down': 0xff54,
            'PageUp': 0xff55,
            'PageDown': 0xff56,
            'End': 0xff57,
            'F1': 0xffbe, 'F2': 0xffbf, 'F3': 0xffc0, 'F4': 0xffc1,
            'F5': 0xffc2, 'F6': 0xffc3, 'F7': 0xffc4, 'F8': 0xffc5,
            'Shift': 0xffe1, 'Control': 0xffe3, 'Alt': 0xffe9, 'Meta': 0xffeb
        };

        if (map[e.key]) return map[e.key];
        if (e.key.length === 1) return e.key.charCodeAt(0);
        return 0;
    }

    sendMacro(type) {
        if (this.isDemoMode && this.demoState) {
            if (window.showToast) window.showToast(`Executed Macro: ${type} on Demo Desktop`, 'info');
            return;
        }

        if (!this.isConnected) {
            if (window.showToast) window.showToast('Please connect to a VNC session first', 'error');
            return;
        }

        this.log(`Sending macro: ${type}`);
        if (type === 'CAD') {
            // Send Ctrl+Alt+Del sequence
            this.sendRawKeySym(0xffe3, true);  // Ctrl down
            this.sendRawKeySym(0xffe9, true);  // Alt down
            this.sendRawKeySym(0xffff, true);  // Del down
            this.sendRawKeySym(0xffff, false); // Del up
            this.sendRawKeySym(0xffe9, false); // Alt up
            this.sendRawKeySym(0xffe3, false); // Ctrl up
        } else if (type === 'ALTTAB') {
            this.sendRawKeySym(0xffe9, true);  // Alt down
            this.sendRawKeySym(0xff09, true);  // Tab down
            this.sendRawKeySym(0xff09, false); // Tab up
            this.sendRawKeySym(0xffe9, false); // Alt up
        } else if (type === 'SUPER') {
            this.sendRawKeySym(0xffeb, true);  // Super down
            this.sendRawKeySym(0xffeb, false); // Super up
        } else if (type === 'ESC') {
            this.sendRawKeySym(0xff1b, true);  // Esc down
            this.sendRawKeySym(0xff1b, false); // Esc up
        }
    }

    sendRawKeySym(keySym, isDown) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = new Uint8Array(8);
            const view = new DataView(msg.buffer);
            view.setUint8(0, 4);
            view.setUint8(1, isDown ? 1 : 0);
            view.setUint32(4, keySym, false);
            this.ws.send(msg);
        }
    }

    sendText(str) {
        if (this.isDemoMode && this.demoState) {
            this.demoState.terminalOutput.push(`pulseops@vnc-demo:~$ ${str}`);
            if (window.showToast) window.showToast(`Pushed text into Demo Terminal: "${str}"`, 'success');
            return;
        }

        if (!this.isConnected) {
            if (window.showToast) window.showToast('Please connect to VNC session first', 'error');
            return;
        }

        this.log(`Sending text string (${str.length} chars) to remote session...`);
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            this.sendRawKeySym(code, true);
            this.sendRawKeySym(code, false);
        }
        if (window.showToast) window.showToast('Text sent to remote clipboard/keyboard buffer', 'success');
    }

    // -------------------------------------------------------------
    // Interactive VNC Desktop Simulator (Demo / Test Mode)
    // -------------------------------------------------------------

    startDemoMode() {
        this.log('Launching Interactive VNC Desktop Simulator...');
        this.isDemoMode = true;
        this.width = 1280;
        this.height = 800;

        if (this.canvas) {
            this.canvas.width = this.width;
            this.canvas.height = this.height;
        }

        if (this.overlay) this.overlay.classList.add('hidden');
        if (this.connectBtn) this.connectBtn.style.display = 'none';
        if (this.disconnectBtn) this.disconnectBtn.style.display = 'inline-flex';
        this.updateStatus('DEMO DESKTOP', 'connected');

        this.demoState = {
            cursor: { x: 640, y: 400 },
            activeApp: 'telemetry',
            windows: [
                { id: 'telemetry', title: 'PulseOps System Performance Monitor', x: 80, y: 70, w: 620, h: 420, active: true },
                { id: 'terminal', title: 'Bash Terminal Console — pulseops@linux', x: 580, y: 220, w: 600, h: 450, active: false },
                { id: 'files', title: 'Filesystem Explorer — /var/log/pulseops', x: 220, y: 320, w: 500, h: 360, active: false }
            ],
            cpuHistory: Array(30).fill(15),
            terminalOutput: [
                'PulseOps VNC Graphical Desktop Session initialized.',
                'Connected to local X11 display :0 via RFB protocol.',
                'Type commands in text box above to send key inputs into terminal.'
            ],
            dragWindow: null,
            dragOffset: { x: 0, y: 0 }
        };

        this.runDemoAnimation();
    }

    stopDemoMode() {
        this.isDemoMode = false;
        if (this.demoAnimId) cancelAnimationFrame(this.demoAnimId);
        this.demoState = null;
        this.log('Interactive Desktop Simulator stopped.');
        this.onDisconnected();
    }

    runDemoAnimation() {
        if (!this.isDemoMode || !this.ctx) return;

        this.frameCount++;
        this.renderDemoDesktop();

        // Update CPU simulation graph data periodically
        if (Math.random() < 0.1) {
            const nextVal = Math.max(5, Math.min(95, this.demoState.cpuHistory[this.demoState.cpuHistory.length - 1] + (Math.random() * 20 - 10)));
            this.demoState.cpuHistory.push(parseFloat(nextVal.toFixed(1)));
            this.demoState.cpuHistory.shift();
        }

        this.demoAnimId = requestAnimationFrame(() => this.runDemoAnimation());
    }

    renderDemoDesktop() {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;

        // 1. Desktop Wallpaper Background Gradient
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#0a0f1d');
        grad.addColorStop(0.5, '#070a14');
        grad.addColorStop(1, '#0e1830');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Glowing tech background grid lines
        ctx.strokeStyle = 'rgba(0, 242, 254, 0.03)';
        ctx.lineWidth = 1;
        for (let x = 0; x < w; x += 40) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += 40) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }

        // 2. Render Desktop Windows
        this.demoState.windows.forEach(win => {
            this.renderDemoWindow(win);
        });

        // 3. Desktop Top Panel Bar
        ctx.fillStyle = 'rgba(10, 15, 27, 0.9)';
        ctx.fillRect(0, 0, w, 36);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.beginPath(); ctx.moveTo(0, 36); ctx.lineTo(w, 36); ctx.stroke();

        ctx.fillStyle = '#00f2fe';
        ctx.font = 'bold 13px Inter, sans-serif';
        ctx.fillText('⚡ PulseOps VNC Desktop', 15, 23);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.fillText('Host: localhost (127.0.0.1:5900)  |  Session: RFB 003.008', 220, 23);

        const clockStr = new Date().toLocaleTimeString();
        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(`🕒 ${clockStr}`, w - 110, 23);

        // 4. Desktop Dock / Launcher Bar (Bottom)
        const dockW = 260;
        const dockX = (w - dockW) / 2;
        ctx.fillStyle = 'rgba(14, 20, 36, 0.85)';
        ctx.beginPath();
        ctx.roundRect(dockX, h - 55, dockW, 45, 12);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 242, 254, 0.25)';
        ctx.stroke();

        const icons = [
            { id: 'telemetry', label: '📊' },
            { id: 'terminal', label: '💻' },
            { id: 'files', label: '📁' },
            { id: 'settings', label: '⚙️' }
        ];
        icons.forEach((ic, i) => {
            const ix = dockX + 25 + i * 60;
            const iy = h - 32;
            ctx.font = '22px sans-serif';
            ctx.fillText(ic.label, ix, iy);
            if (this.demoState.windows.some(win => win.id === ic.id)) {
                ctx.fillStyle = '#00f2fe';
                ctx.beginPath(); ctx.arc(ix + 11, h - 14, 3, 0, Math.PI * 2); ctx.fill();
            }
        });

        // 5. Draw Pointer Cursor
        const cur = this.demoState.cursor;
        ctx.fillStyle = '#00f2fe';
        ctx.beginPath();
        ctx.moveTo(cur.x, cur.y);
        ctx.lineTo(cur.x + 12, cur.y + 12);
        ctx.lineTo(cur.x + 5, cur.y + 14);
        ctx.lineTo(cur.x, cur.y + 18);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    renderDemoWindow(win) {
        const ctx = this.ctx;
        
        // Window Frame Outer Shadow
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 15;
        ctx.shadowOffsetY = 8;

        // Window Background & Header
        ctx.fillStyle = '#0c1220';
        ctx.beginPath();
        ctx.roundRect(win.x, win.y, win.w, win.h, 8);
        ctx.fill();
        ctx.shadowBlur = 0; // Reset shadow

        // Window Border
        ctx.strokeStyle = win.active ? 'rgba(0, 242, 254, 0.4)' : 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Window Header Bar
        ctx.fillStyle = win.active ? '#131b2e' : '#090e1a';
        ctx.beginPath();
        ctx.roundRect(win.x, win.y, win.w, 32, [8, 8, 0, 0]);
        ctx.fill();

        // Window Title
        ctx.fillStyle = win.active ? '#f1f5f9' : '#64748b';
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.fillText(win.title, win.x + 40, win.y + 20);

        // Window Window Controls (Red, Yellow, Green dots)
        ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(win.x + 15, win.y + 16, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f59e0b'; ctx.beginPath(); ctx.arc(win.x + 27, win.y + 16, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#10b981'; ctx.beginPath(); ctx.arc(win.x + 39, win.y + 16, 5, 0, Math.PI * 2); ctx.fill();

        // Window Content Body
        const cx = win.x + 12;
        const cy = win.y + 44;
        const cw = win.w - 24;
        const ch = win.h - 56;

        if (win.id === 'telemetry') {
            ctx.fillStyle = '#060a14';
            ctx.fillRect(cx, cy, cw, ch);

            ctx.fillStyle = '#00f2fe';
            ctx.font = '12px Inter, sans-serif';
            ctx.fillText('CPU Utilization History (Live VNC Engine Feed):', cx + 10, cy + 25);

            // Chart area
            const chartX = cx + 10;
            const chartY = cy + 40;
            const chartW = cw - 20;
            const chartH = ch - 60;

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.strokeRect(chartX, chartY, chartW, chartH);

            const hist = this.demoState.cpuHistory;
            const step = chartW / (hist.length - 1);

            ctx.beginPath();
            hist.forEach((v, idx) => {
                const px = chartX + idx * step;
                const py = chartY + chartH - (v / 100) * chartH;
                if (idx === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            });
            ctx.strokeStyle = '#00f2fe';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Fill under graph
            ctx.lineTo(chartX + chartW, chartY + chartH);
            ctx.lineTo(chartX, chartY + chartH);
            ctx.fillStyle = 'rgba(0, 242, 254, 0.1)';
            ctx.fill();

            const curVal = hist[hist.length - 1];
            ctx.fillStyle = '#8b5cf6';
            ctx.font = 'bold 14px "JetBrains Mono", monospace';
            ctx.fillText(`Current CPU Load: ${curVal}%`, chartX + 10, chartY + chartH + 18);

        } else if (win.id === 'terminal') {
            ctx.fillStyle = '#04070d';
            ctx.fillRect(cx, cy, cw, ch);

            ctx.font = '12px "JetBrains Mono", monospace';
            this.demoState.terminalOutput.slice(-12).forEach((line, idx) => {
                ctx.fillStyle = line.startsWith('pulseops') ? '#00f2fe' : '#94a3b8';
                ctx.fillText(line, cx + 10, cy + 22 + idx * 20);
            });

            // Cursor blink
            if (Math.floor(Date.now() / 500) % 2 === 0) {
                const lastLineY = cy + 22 + (Math.min(12, this.demoState.terminalOutput.length) - 1) * 20;
                ctx.fillStyle = '#00f2fe';
                ctx.fillRect(cx + 10 + ctx.measureText(this.demoState.terminalOutput[this.demoState.terminalOutput.length - 1] || '').width + 4, lastLineY - 10, 8, 14);
            }

        } else if (win.id === 'files') {
            ctx.fillStyle = '#090e18';
            ctx.fillRect(cx, cy, cw, ch);

            const fileItems = [
                { name: 'pulseops-daemon.log', size: '4.2 MB', type: '📄 Log' },
                { name: 'systemd-journal.sock', size: '0 B', type: '🔌 Socket' },
                { name: 'rfb_vnc_bridge.config', size: '1.2 KB', type: '⚙️ Config' },
                { name: 'pulseops.service', size: '340 B', type: '⚡ Service' }
            ];

            fileItems.forEach((item, idx) => {
                ctx.fillStyle = idx % 2 === 0 ? 'rgba(255, 255, 255, 0.02)' : 'transparent';
                ctx.fillRect(cx + 5, cy + 10 + idx * 32, cw - 10, 28);

                ctx.fillStyle = '#f1f5f9';
                ctx.font = '12px "JetBrains Mono", monospace';
                ctx.fillText(`${item.type}  ${item.name}`, cx + 15, cy + 28 + idx * 32);

                ctx.fillStyle = '#64748b';
                ctx.fillText(item.size, cx + cw - 90, cy + 28 + idx * 32);
            });
        }
    }

    handleDemoPointer(x, y, type, button) {
        if (!this.demoState) return;
        this.demoState.cursor = { x, y };

        if (type === 'down') {
            // Check window title bar drag
            for (let i = this.demoState.windows.length - 1; i >= 0; i--) {
                const win = this.demoState.windows[i];
                if (x >= win.x && x <= win.x + win.w && y >= win.y && y <= win.y + 32) {
                    // Activate clicked window
                    this.demoState.windows.forEach(w => w.active = false);
                    win.active = true;
                    this.demoState.dragWindow = win;
                    this.demoState.dragOffset = { x: x - win.x, y: y - win.y };
                    break;
                }
            }
        } else if (type === 'move') {
            if (this.demoState.dragWindow) {
                this.demoState.dragWindow.x = x - this.demoState.dragOffset.x;
                this.demoState.dragWindow.y = y - this.demoState.dragOffset.y;
            }
        } else if (type === 'up') {
            this.demoState.dragWindow = null;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.vncMgr = new PulseOpsVNCManager();
});
