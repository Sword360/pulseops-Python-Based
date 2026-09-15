/* ==========================================================================
   PulseOps - Docker & Container Management Module
   Provides container listing, lifecycle actions (start, stop, restart,
   pause, unpause, remove), real-time logs, and inspection across master & fleet.
   ========================================================================== */

function _authDockerFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class DockerManager {
    constructor() {
        this.containers = [];
        this.filter = 'all'; // 'all' | 'running' | 'paused' | 'exited'
        this.searchQuery = '';
        this.currentLogContainer = null;
        this.currentLogContainerName = '';
        this.logAutoRefreshTimer = null;
        this.statusInfo = null;

        this.initDOM();
    }

    initDOM() {
        this.tableBody = document.getElementById('docker-table-body');
        this.searchInput = document.getElementById('docker-search');
        this.filterBtns = document.querySelectorAll('[data-docker-filter]');
        this.refreshBtn = document.getElementById('docker-refresh-btn');
        this.engineBadge = document.getElementById('docker-engine-badge');
        this.engineInfo = document.getElementById('docker-engine-info');

        this.totalCountEl = document.getElementById('docker-count-total');
        this.runningCountEl = document.getElementById('docker-count-running');
        this.pausedCountEl = document.getElementById('docker-count-paused');
        this.exitedCountEl = document.getElementById('docker-count-exited');

        // Logs modal elements
        this.logsModal = document.getElementById('docker-logs-modal');
        this.logsTitle = document.getElementById('docker-logs-title');
        this.logsSubtitle = document.getElementById('docker-logs-subtitle');
        this.logsContent = document.getElementById('docker-logs-content');
        this.logsLinesSelect = document.getElementById('docker-logs-lines-select');
        this.logsRefreshBtn = document.getElementById('docker-logs-refresh-btn');
        this.logsCopyBtn = document.getElementById('docker-logs-copy-btn');

        // Inspect modal elements
        this.inspectModal = document.getElementById('docker-inspect-modal');
        this.inspectTitle = document.getElementById('docker-inspect-title');
        this.inspectSub = document.getElementById('docker-inspect-sub');
        this.inspectBadge = document.getElementById('docker-inspect-badge');
        this.inspectBody = document.getElementById('docker-inspect-body');

        // Search input
        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase().trim();
                this.render();
            });
        }

        // Filter buttons
        if (this.filterBtns) {
            this.filterBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    this.filterBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.filter = btn.dataset.dockerFilter || 'all';
                    this.render();
                });
            });
        }

        // Refresh button
        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => {
                this.loadContainers(true);
            });
        }

        // Logs modal events
        if (this.logsLinesSelect) {
            this.logsLinesSelect.addEventListener('change', () => {
                if (this.currentLogContainer) {
                    this.fetchLogs(this.currentLogContainer);
                }
            });
        }
        if (this.logsRefreshBtn) {
            this.logsRefreshBtn.addEventListener('click', () => {
                if (this.currentLogContainer) {
                    this.fetchLogs(this.currentLogContainer);
                }
            });
        }
        if (this.logsCopyBtn) {
            this.logsCopyBtn.addEventListener('click', () => {
                if (this.logsContent && this.logsContent.textContent) {
                    navigator.clipboard.writeText(this.logsContent.textContent)
                        .then(() => window.showToast && window.showToast('Copied logs to clipboard!', 'success'))
                        .catch(() => window.showToast && window.showToast('Failed to copy logs', 'error'));
                }
            });
        }

        // Table action button delegation
        if (this.tableBody) {
            this.tableBody.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-docker-action]');
                if (!btn) return;
                const cid = btn.dataset.containerId;
                const cname = btn.dataset.containerName || cid;
                const action = btn.dataset.dockerAction;

                if (action === 'logs') {
                    this.openLogsModal(cid, cname);
                } else if (action === 'inspect') {
                    this.openInspectModal(cid, cname);
                } else {
                    this.executeAction(cid, action, cname);
                }
            });
        }
    }

    _getCurrentServerId() {
        return window.PulseOpsCurrentServer || (window.PulseOpsApp ? window.PulseOpsApp.currentServerId : 'local-master');
    }

    _getCurrentServerHostname() {
        const sId = this._getCurrentServerId();
        return window.PulseOpsCurrentServerHostname || (sId === 'local-master' ? 'Master Host' : 'Remote Node');
    }

    async loadContainers(showFeedback = false) {
        const sId = this._getCurrentServerId();
        const hostname = this._getCurrentServerHostname();

        if (showFeedback && window.showToast) {
            window.showToast(`Refreshing containers on ${hostname}...`, 'info', 2000);
        }

        if (this.tableBody && (!this.containers || this.containers.length === 0)) {
            this.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim); padding:2.5rem;">
                <span class="spinner-sm" style="display:inline-block; margin-right:8px;">⏳</span> Fetching containers from <strong>${hostname}</strong>...
            </td></tr>`;
        }

        try {
            // 1. Fetch status first or parallel
            const [statusRes, listRes] = await Promise.all([
                _authDockerFetch(`/api/docker/status?server_id=${encodeURIComponent(sId)}`),
                _authDockerFetch(`/api/docker/containers?server_id=${encodeURIComponent(sId)}&all=true`)
            ]);

            const statusData = await statusRes.json();
            const listData = await listRes.json();

            this.statusInfo = statusData;
            this.updateEngineHeader(statusData, listData);

            if (listData.need_update) {
                this.containers = [];
                this.updateCounters();
                if (this.tableBody) {
                    const upgradeCmd = `curl -sSL ${window.location.origin}/api/fleet/agent-update.sh | sudo bash`;
                    this.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 3rem 1.5rem;">
                        <div style="max-width: 580px; margin: 0 auto; background: var(--bg-card); border: 1px solid var(--accent-cyan); border-radius: 8px; padding: 1.5rem; text-align: left;">
                            <div style="font-size: 1.1rem; font-weight: 700; color: var(--accent-cyan); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                                🚀 Upgrade Agent to Manage Containers
                            </div>
                            <p style="color: var(--text-secondary); font-size: 0.88rem; line-height: 1.5; margin-bottom: 1rem;">
                                The PulseOps agent on <strong>${hostname}</strong> is running an older build. Run this command on the remote host to unlock Docker container management, live inspection, and logs:
                            </p>
                            <div style="background: rgba(0,0,0,0.6); border: 1px solid var(--border-color); padding: 0.75rem 1rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.82rem; color: var(--accent-green); display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
                                <span style="word-break: break-all;">${upgradeCmd}</span>
                                <button class="btn btn-sm btn-primary" style="white-space: nowrap;" onclick="navigator.clipboard.writeText('${upgradeCmd}'); window.showToast && window.showToast('Copied upgrade command to clipboard!', 'success');">Copy Command</button>
                            </div>
                        </div>
                    </td></tr>`;
                }
                return;
            }

            if (listData.success) {
                this.containers = listData.containers || [];
                this.updateCounters();
                this.render();
                if (showFeedback && window.showToast) {
                    window.showToast(`Loaded ${this.containers.length} containers successfully`, 'success', 2500);
                }
            } else {
                this.containers = [];
                this.updateCounters();
                if (this.tableBody) {
                    const isAuthError = errStr.includes('Unauthorized') || listData.token_mismatch || resList.status === 401;
                    if (isAuthError) {
                        this.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 2.5rem 1.5rem;">
                            <div style="max-width: 620px; margin: 0 auto; background: var(--bg-card); border: 1px solid rgba(234,179,8,0.5); border-radius: 8px; padding: 1.5rem; text-align: left;">
                                <div style="font-size: 1.05rem; font-weight: 700; color: #eab308; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                                    🔑 Agent Authentication Token Mismatch on ${hostname}
                                </div>
                                <p style="color: var(--text-secondary); font-size: 0.88rem; line-height: 1.5; margin-bottom: 1rem;">
                                    The remote agent rejected the request (401 Unauthorized). The agent daemon is running with an out-of-sync token in memory. Run this command on <strong>${hostname}</strong> to reload its configuration:
                                </p>
                                <div style="background: rgba(0,0,0,0.6); border: 1px solid var(--border-color); padding: 0.75rem 1rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.82rem; color: var(--accent-green); display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                                    <span style="word-break: break-all;">sudo systemctl restart pulseops-agent</span>
                                    <button class="btn btn-sm btn-primary" style="white-space: nowrap;" onclick="navigator.clipboard.writeText('sudo systemctl restart pulseops-agent'); window.showToast && window.showToast('Copied restart command to clipboard!', 'success');">Copy Command</button>
                                </div>
                                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                                    <span style="font-size:0.78rem; color:var(--text-dim);">Or update: <code style="color:var(--accent-cyan);">curl -sSL ${window.location.origin}/api/fleet/agent-update.sh | sudo bash</code></span>
                                    <button class="btn btn-sm btn-secondary" onclick="window.dockerMgr && window.dockerMgr.loadContainers(true)">🔄 Retry Connection</button>
                                </div>
                            </div>
                        </td></tr>`;
                    } else if (errStr.includes('Cannot connect to agent') || errStr.includes('Connection refused')) {
                        this.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 2.5rem 1.5rem;">
                            <div style="max-width: 620px; margin: 0 auto; background: var(--bg-card); border: 1px solid rgba(239,68,68,0.4); border-radius: 8px; padding: 1.5rem; text-align: left;">
                                <div style="font-size: 1.05rem; font-weight: 700; color: var(--accent-red); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                                    ⚠️ PulseOps Agent Offline on ${hostname}
                                </div>
                                <p style="color: var(--text-secondary); font-size: 0.88rem; line-height: 1.5; margin-bottom: 1rem;">
                                    The remote machine is reachable, but the PulseOps agent daemon (port 3501) is currently stopped or connection was refused. Run this command on <strong>${hostname}</strong> to start the agent:
                                </p>
                                <div style="background: rgba(0,0,0,0.6); border: 1px solid var(--border-color); padding: 0.75rem 1rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.82rem; color: var(--accent-green); display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                                    <span style="word-break: break-all;">sudo systemctl restart pulseops-agent</span>
                                    <button class="btn btn-sm btn-primary" style="white-space: nowrap;" onclick="navigator.clipboard.writeText('sudo systemctl restart pulseops-agent'); window.showToast && window.showToast('Copied start command to clipboard!', 'success');">Copy Command</button>
                                </div>
                                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                                    <span style="font-size:0.78rem; color:var(--text-dim);">Or reinstall: <code style="color:var(--accent-cyan);">curl -sSL ${window.location.origin}/api/fleet/agent-update.sh | sudo bash</code></span>
                                    <button class="btn btn-sm btn-secondary" onclick="window.dockerMgr && window.dockerMgr.loadContainers(true)">🔄 Retry Connection</button>
                                </div>
                            </div>
                        </td></tr>`;
                    } else {
                        this.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--accent-red); padding:2rem;">
                            ❌ Error loading containers: ${errStr}
                        </td></tr>`;
                    }
                }
            }
        } catch (err) {
            console.error('[DockerManager] Load failed:', err);
            if (this.tableBody) {
                this.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim); padding:2rem;">
                    Failed to communicate with host container daemon. Check network or server status.
                </td></tr>`;
            }
        }
    }

    updateEngineHeader(status, listData) {
        if (!this.engineBadge || !this.engineInfo) return;

        const isSimulated = listData && listData.fallback;
        const engineType = (status && status.engine) || (listData && listData.engine) || 'docker';
        const engineLabel = engineType.toUpperCase();

        if (status && status.available) {
            this.engineBadge.className = 'badge badge-active';
            this.engineBadge.innerHTML = `🐳 ${engineLabel} Active`;
            const ver = status.version ? `v${status.version}` : 'Runtime online';
            const socketNotice = status.socket ? '• Unix socket connected' : '';
            this.engineInfo.textContent = `${engineLabel} Engine ${ver} ${socketNotice}`;
        } else if (isSimulated) {
            this.engineBadge.className = 'badge badge-paused';
            this.engineBadge.innerHTML = `🧪 Simulated Demo`;
            this.engineInfo.textContent = 'Container engine not detected on host — running in high-fidelity simulation mode.';
        } else {
            this.engineBadge.className = 'badge badge-inactive';
            this.engineBadge.innerHTML = `⚠️ ${engineLabel} Inactive`;
            this.engineInfo.textContent = status?.error || 'Docker service is not responding on target host.';
        }
    }

    updateCounters() {
        let running = 0, paused = 0, exited = 0;
        this.containers.forEach(c => {
            const st = (c.state || '').toLowerCase();
            if (st === 'running' || (!st && (c.status || '').toLowerCase().includes('up'))) {
                running++;
            } else if (st === 'paused') {
                paused++;
            } else {
                exited++;
            }
        });

        if (this.totalCountEl) this.totalCountEl.textContent = this.containers.length;
        if (this.runningCountEl) this.runningCountEl.textContent = running;
        if (this.pausedCountEl) this.pausedCountEl.textContent = paused;
        if (this.exitedCountEl) this.exitedCountEl.textContent = exited;
    }

    async executeAction(containerId, action, containerName) {
        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;
        if (!isOperator) {
            window.showToast && window.showToast('Permission denied: Viewer accounts cannot modify containers.', 'error');
            return;
        }

        if (action === 'remove') {
            const confirmed = window.confirm(`Are you sure you want to forcibly remove container "${containerName}" (${containerId})?\n\nThis action cannot be undone.`);
            if (!confirmed) return;
        }

        const sId = this._getCurrentServerId();
        const actionLabels = {
            start: 'Starting',
            stop: 'Stopping',
            restart: 'Restarting',
            pause: 'Pausing',
            unpause: 'Unpausing',
            remove: 'Removing'
        };

        window.showToast && window.showToast(`${actionLabels[action] || action} container ${containerName}...`, 'info', 2500);

        try {
            const res = await _authDockerFetch('/api/docker/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    container_id: containerId,
                    action: action,
                    server_id: sId
                })
            });

            const data = await res.json();
            if (data.success) {
                window.showToast && window.showToast(data.message || `Container ${containerName} ${action}ed successfully.`, 'success', 3500);
                this.loadContainers();
            } else {
                window.showToast && window.showToast(data.error || data.detail || `Failed to ${action} container.`, 'error', 5000);
            }
        } catch (err) {
            console.error('[DockerManager] Action error:', err);
            window.showToast && window.showToast(`Network error performing ${action} on container.`, 'error');
        }
    }

    async openLogsModal(containerId, containerName) {
        if (!this.logsModal) return;
        this.currentLogContainer = containerId;
        this.currentLogContainerName = containerName;

        this.logsTitle.textContent = `Container Logs: ${containerName}`;
        this.logsSubtitle.textContent = `Container ID: ${containerId} | Host: ${this._getCurrentServerHostname()}`;
        this.logsContent.textContent = 'Loading live container logs...';

        this.logsModal.classList.add('active');
        this.logsModal.style.display = 'flex';

        await this.fetchLogs(containerId);
    }

    async fetchLogs(containerId) {
        if (!this.logsContent) return;
        const sId = this._getCurrentServerId();
        const lines = this.logsLinesSelect ? this.logsLinesSelect.value : 100;

        try {
            const res = await _authDockerFetch(`/api/docker/logs?container=${encodeURIComponent(containerId)}&lines=${lines}&server_id=${encodeURIComponent(sId)}`);
            const data = await res.json();

            if (data.success) {
                this.logsContent.textContent = data.logs || '(No logs recorded for this container)';
                // Scroll to bottom
                this.logsContent.scrollTop = this.logsContent.scrollHeight;
            } else {
                this.logsContent.textContent = `Error fetching logs: ${data.error || data.detail || 'Unknown error'}`;
            }
        } catch (err) {
            this.logsContent.textContent = 'Network error fetching container logs.';
        }
    }

    async openInspectModal(containerId, containerName) {
        if (!this.inspectModal) return;
        const sId = this._getCurrentServerId();

        this.inspectTitle.textContent = `Inspect: ${containerName}`;
        this.inspectSub.textContent = `ID: ${containerId} • Target Host: ${this._getCurrentServerHostname()}`;
        this.inspectBadge.className = 'badge badge-inactive';
        this.inspectBadge.textContent = 'Loading...';
        this.inspectBody.innerHTML = `<div style="text-align:center; color:var(--text-dim); padding:2rem;">
            <span class="spinner-sm">⏳</span> Reading container metadata and network bindings...
        </div>`;

        this.inspectModal.classList.add('active');
        this.inspectModal.style.display = 'flex';

        try {
            const res = await _authDockerFetch(`/api/docker/inspect?container=${encodeURIComponent(containerId)}&server_id=${encodeURIComponent(sId)}`);
            const data = await res.json();

            if (data.success && data.details) {
                this.renderInspectDetails(data.details);
            } else {
                this.inspectBody.innerHTML = `<div style="color:var(--accent-red); padding:1.5rem; text-align:center;">
                    ❌ Failed to inspect container: ${data.error || data.detail || 'Metadata not found'}
                </div>`;
            }
        } catch (err) {
            this.inspectBody.innerHTML = `<div style="color:var(--text-dim); padding:1.5rem; text-align:center;">
                Network error inspecting container.
            </div>`;
        }
    }

    renderInspectDetails(d) {
        const state = (d.state || '').toLowerCase();
        let badgeCls = 'badge-inactive';
        if (state === 'running' || d.running) badgeCls = 'badge-active';
        else if (state === 'paused' || d.paused) badgeCls = 'badge-paused';

        this.inspectBadge.className = `badge ${badgeCls}`;
        this.inspectBadge.textContent = (d.state || (d.running ? 'running' : 'exited')).toUpperCase();

        const portsFormatted = (d.ports && d.ports.length > 0)
            ? d.ports.map(p => `<span class="inspect-tag">${p}</span>`).join(' ')
            : '<span style="color:var(--text-dim);">None</span>';

        const mountsFormatted = (d.mounts && d.mounts.length > 0)
            ? d.mounts.map(m => `
                <div class="inspect-row-item">
                    <span style="font-weight:600; color:var(--accent-cyan); font-family:var(--font-mono);">${m.destination}</span>
                    <span style="color:var(--text-dim); font-size:0.75rem;">← ${m.source} (${m.rw ? 'Read/Write' : 'Read-Only'})</span>
                </div>
            `).join('')
            : '<span style="color:var(--text-dim);">No custom volume mounts attached</span>';

        const envFormatted = (d.env && d.env.length > 0)
            ? d.env.map(e => `<div class="inspect-env-item font-mono">${e}</div>`).join('')
            : '<span style="color:var(--text-dim);">No environment variables configured</span>';

        this.inspectBody.innerHTML = `
            <div class="inspect-grid">
                <div class="inspect-section">
                    <h4 class="inspect-section-title">General Information</h4>
                    <div class="inspect-kv-list">
                        <div class="inspect-kv"><span class="k">Full ID:</span><span class="v font-mono">${d.full_id || d.id}</span></div>
                        <div class="inspect-kv"><span class="k">Image:</span><span class="v font-mono" style="color:var(--accent-purple);">${d.image || '--'}</span></div>
                        <div class="inspect-kv"><span class="k">Started At:</span><span class="v">${d.started_at ? new Date(d.started_at).toLocaleString() : '--'}</span></div>
                        <div class="inspect-kv"><span class="k">PID:</span><span class="v font-mono">${d.pid || '--'}</span></div>
                        <div class="inspect-kv"><span class="k">Restart Policy:</span><span class="v font-mono">${d.restart_policy || 'no'}</span></div>
                        <div class="inspect-kv"><span class="k">Working Dir:</span><span class="v font-mono">${d.working_dir || '/'}</span></div>
                        <div class="inspect-kv"><span class="k">Command:</span><span class="v font-mono">${d.command || '--'}</span></div>
                    </div>
                </div>

                <div class="inspect-section">
                    <h4 class="inspect-section-title">Networking</h4>
                    <div class="inspect-kv-list">
                        <div class="inspect-kv"><span class="k">IP Address:</span><span class="v font-mono" style="color:var(--accent-green);">${d.ip_address || 'Host / None'}</span></div>
                        <div class="inspect-kv"><span class="k">Gateway:</span><span class="v font-mono">${d.gateway || '--'}</span></div>
                        <div class="inspect-kv"><span class="k">MAC Address:</span><span class="v font-mono">${d.mac_address || '--'}</span></div>
                        <div class="inspect-kv" style="flex-direction:column; align-items:flex-start; gap:0.35rem;">
                            <span class="k">Port Bindings:</span>
                            <div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.2rem;">${portsFormatted}</div>
                        </div>
                    </div>
                </div>

                <div class="inspect-section" style="grid-column: 1 / -1;">
                    <h4 class="inspect-section-title">Mounts &amp; Storage Volumes</h4>
                    <div style="display:flex; flex-direction:column; gap:0.4rem;">
                        ${mountsFormatted}
                    </div>
                </div>

                <div class="inspect-section" style="grid-column: 1 / -1;">
                    <h4 class="inspect-section-title">Environment Variables</h4>
                    <div class="inspect-env-container">
                        ${envFormatted}
                    </div>
                </div>
            </div>
        `;
    }

    render() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';

        let filtered = this.containers.filter(c => {
            const matchesSearch = !this.searchQuery ||
                c.name.toLowerCase().includes(this.searchQuery) ||
                c.id.toLowerCase().includes(this.searchQuery) ||
                c.image.toLowerCase().includes(this.searchQuery) ||
                (c.ports && c.ports.toLowerCase().includes(this.searchQuery));

            if (!matchesSearch) return false;

            const st = (c.state || '').toLowerCase();
            const isUp = st === 'running' || (!st && (c.status || '').toLowerCase().includes('up'));

            if (this.filter === 'running') return isUp;
            if (this.filter === 'paused') return st === 'paused';
            if (this.filter === 'exited') return !isUp && st !== 'paused';
            return true;
        });

        if (filtered.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="5" style="text-align:center; color:var(--text-dim); padding:2.5rem;">
                No containers found matching current criteria.
            </td>`;
            this.tableBody.appendChild(tr);
            return;
        }

        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;

        filtered.forEach(c => {
            const tr = document.createElement('tr');
            const st = (c.state || '').toLowerCase();
            const isRunning = st === 'running' || (!st && (c.status || '').toLowerCase().includes('up'));
            const isPaused = st === 'paused';
            const isExited = !isRunning && !isPaused;

            let badgeCls = 'badge-inactive';
            let stateLabel = 'EXITED';
            if (isRunning) {
                badgeCls = 'badge-active';
                stateLabel = 'RUNNING';
            } else if (isPaused) {
                badgeCls = 'badge-paused';
                stateLabel = 'PAUSED';
            }

            const safeId = (c.id || '').replace(/"/g, '&quot;');
            const safeName = (c.name || safeId).replace(/"/g, '&quot;');
            const safeImage = (c.image || 'unknown').replace(/"/g, '&quot;');

            let lifecycleButtons = '';
            if (isOperator) {
                if (isRunning) {
                    lifecycleButtons = `
                        <button class="btn-action" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="restart" title="Restart container">🔄</button>
                        <button class="btn-action danger" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="stop" title="Stop container">⏹️</button>
                        <button class="btn-action" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="pause" title="Pause container">⏸️</button>
                    `;
                } else if (isPaused) {
                    lifecycleButtons = `
                        <button class="btn-action" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="unpause" title="Resume container" style="color:var(--accent-green);">▶️</button>
                        <button class="btn-action danger" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="stop" title="Stop container">⏹️</button>
                    `;
                } else {
                    lifecycleButtons = `
                        <button class="btn-action" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="start" title="Start container" style="color:var(--accent-green);">▶️ Start</button>
                        <button class="btn-action danger" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="remove" title="Remove container">🗑️</button>
                    `;
                }
            }

            const portsDisplay = c.ports
                ? `<div style="font-family:var(--font-mono); font-size:0.78rem; color:var(--text-muted); max-width:280px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${c.ports.replace(/"/g, '&quot;')}">${c.ports}</div>`
                : `<span style="color:var(--text-dim); font-size:0.75rem;">--</span>`;

            tr.innerHTML = `
                <td>
                    <div style="font-weight:600; color:var(--text-main); font-size:0.92rem; display:flex; align-items:center; gap:0.4rem;">
                        <span>🐳 ${safeName}</span>
                    </div>
                    <div style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-dim); margin-top:2px;">
                        ID: <span style="color:var(--accent-cyan);">${safeId}</span> • <span style="color:var(--text-muted);">${c.created || ''}</span>
                    </div>
                </td>
                <td>
                    <span style="font-family:var(--font-mono); font-size:0.82rem; color:var(--accent-purple); font-weight:500;" title="${safeImage}">${safeImage}</span>
                </td>
                <td>
                    <div style="display:flex; flex-direction:column; align-items:flex-start; gap:4px;">
                        <span class="badge ${badgeCls}"><span style="font-size:9px;">●</span> ${stateLabel}</span>
                        <span style="font-size:0.75rem; color:var(--text-muted);">${c.status || ''}</span>
                    </div>
                </td>
                <td>
                    ${portsDisplay}
                </td>
                <td style="text-align:right;">
                    <div class="btn-group" style="justify-content:flex-end; gap:4px;">
                        ${lifecycleButtons}
                        <button class="btn-action" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="logs" title="View live logs">📜 Logs</button>
                        <button class="btn-action" data-container-id="${safeId}" data-container-name="${safeName}" data-docker-action="inspect" title="Inspect container details">🔍 Inspect</button>
                    </div>
                </td>
            `;
            this.tableBody.appendChild(tr);
        });
    }
}

// Global initialization
window.dockerMgr = null;
document.addEventListener('DOMContentLoaded', () => {
    window.dockerMgr = new DockerManager();
});
