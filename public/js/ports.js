/* ==========================================================================
   PulseOps - Active Listening Ports & Network Inspector Module
   Provides socket discovery, protocol filtering, and process triage.
   ========================================================================== */

function _authPortsFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class PortsManager {
    constructor() {
        this.ports = [];
        this.filter = 'all'; // 'all' | 'tcp' | 'udp' | 'public' | 'local'
        this.searchQuery = '';

        this.initDOM();
    }

    initDOM() {
        this.tableBody = document.getElementById('ports-table-body');
        this.searchInput = document.getElementById('ports-search');
        this.filterBtns = document.querySelectorAll('[data-ports-filter]');
        this.refreshBtn = document.getElementById('ports-refresh-btn');

        this.totalCountEl = document.getElementById('ports-count-total');
        this.tcpCountEl = document.getElementById('ports-count-tcp');
        this.udpCountEl = document.getElementById('ports-count-udp');
        this.publicCountEl = document.getElementById('ports-count-public');

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase().trim();
                this.render();
            });
        }

        if (this.filterBtns) {
            this.filterBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    this.filterBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.filter = btn.dataset.portsFilter || 'all';
                    this.render();
                });
            });
        }

        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => {
                this.loadPorts(true);
            });
        }

        if (this.tableBody) {
            this.tableBody.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-port-action]');
                if (!btn) return;
                const action = btn.dataset.portAction;
                const portVal = btn.dataset.port;
                const pidVal = btn.dataset.pid;
                const procName = btn.dataset.proc;

                if (action === 'copy') {
                    navigator.clipboard.writeText(portVal)
                        .then(() => window.showToast && window.showToast(`Copied ${portVal} to clipboard!`, 'success'))
                        .catch(() => window.showToast && window.showToast('Failed to copy', 'error'));
                } else if (action === 'kill-pid') {
                    this.killProcess(pidVal, procName);
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

    async loadPorts(showFeedback = false) {
        const sId = this._getCurrentServerId();
        const hostname = this._getCurrentServerHostname();

        if (showFeedback && window.showToast) {
            window.showToast(`Scanning open sockets on ${hostname}...`, 'info', 2000);
        }

        if (this.tableBody && (!this.ports || this.ports.length === 0)) {
            this.tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:2.5rem;">
                <span class="spinner-sm" style="display:inline-block; margin-right:8px;">⏳</span> Inspecting network sockets on <strong>${hostname}</strong>...
            </td></tr>`;
        }

        try {
            const res = await _authPortsFetch(`/api/network/ports?server_id=${encodeURIComponent(sId)}`);
            const data = await res.json();

            if (data.need_update) {
                this.ports = [];
                this.updateCounters();
                if (this.tableBody) {
                    const upgradeCmd = `curl -sSL ${window.location.origin}/api/fleet/agent-update.sh | sudo bash`;
                    this.tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 3rem 1.5rem;">
                        <div style="max-width: 580px; margin: 0 auto; background: var(--bg-card); border: 1px solid var(--accent-cyan); border-radius: 8px; padding: 1.5rem; text-align: left;">
                            <div style="font-size: 1.1rem; font-weight: 700; color: var(--accent-cyan); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                                🚀 Upgrade Agent to Inspect Listening Ports
                            </div>
                            <p style="color: var(--text-secondary); font-size: 0.88rem; line-height: 1.5; margin-bottom: 1rem;">
                                The PulseOps agent on <strong>${hostname}</strong> is running an older build. Run this command on the remote host to enable real-time socket inspection:
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

            if (data.success) {
                this.ports = data.ports || [];
                this.updateCounters();
                this.render();
                if (showFeedback && window.showToast) {
                    window.showToast(`Found ${this.ports.length} active listening sockets`, 'success', 2500);
                }
            } else {
                this.ports = [];
                this.updateCounters();
                if (this.tableBody) {
                    const errStr = data.error || data.detail || 'Unknown error';
                    const isAuthError = errStr.includes('Unauthorized') || data.token_mismatch || res.status === 401;
                    if (isAuthError) {
                        this.tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 2.5rem 1.5rem;">
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
                                    <button class="btn btn-sm btn-secondary" onclick="window.portsMgr && window.portsMgr.loadPorts(true)">🔄 Retry Connection</button>
                                </div>
                            </div>
                        </td></tr>`;
                    } else if (errStr.includes('Cannot connect to agent') || errStr.includes('Connection refused')) {
                        this.tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 2.5rem 1.5rem;">
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
                                    <button class="btn btn-sm btn-secondary" onclick="window.portsMgr && window.portsMgr.loadPorts(true)">🔄 Retry Connection</button>
                                </div>
                            </div>
                        </td></tr>`;
                    } else {
                        this.tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--accent-red); padding:2rem;">
                            ❌ Failed to inspect listening ports: ${errStr}
                        </td></tr>`;
                    }
                }
            }
        } catch (err) {
            console.error('[PortsManager] Error:', err);
            if (this.tableBody) {
                this.tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:2rem;">
                    Failed to communicate with host socket inspector.
                </td></tr>`;
            }
        }
    }

    updateCounters() {
        let tcp = 0, udp = 0, pub = 0;
        this.ports.forEach(p => {
            if (p.protocol === 'TCP') tcp++;
            else if (p.protocol === 'UDP') udp++;
            if (p.is_public) pub++;
        });

        if (this.totalCountEl) this.totalCountEl.textContent = this.ports.length;
        if (this.tcpCountEl) this.tcpCountEl.textContent = tcp;
        if (this.udpCountEl) this.udpCountEl.textContent = udp;
        if (this.publicCountEl) this.publicCountEl.textContent = pub;
    }

    async killProcess(pid, procName) {
        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;
        if (!isOperator) {
            window.showToast && window.showToast('Permission denied: Viewers cannot terminate processes.', 'error');
            return;
        }

        const confirmed = window.confirm(`Are you sure you want to terminate process "${procName}" (PID: ${pid})?`);
        if (!confirmed) return;

        const sId = this._getCurrentServerId();
        try {
            window.showToast && window.showToast(`Terminating PID ${pid} (${procName})...`, 'info', 2000);
            const res = await _authPortsFetch('/api/processes/kill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pid: parseInt(pid, 10), signal: 15, server_id: sId })
            });
            const data = await res.json();
            if (data.success) {
                window.showToast && window.showToast(`Process ${procName} (PID ${pid}) terminated successfully.`, 'success', 3000);
                setTimeout(() => this.loadPorts(), 1000);
            } else {
                window.showToast && window.showToast(data.message || data.error || 'Failed to kill process.', 'error', 4000);
            }
        } catch (e) {
            window.showToast && window.showToast('Network error while terminating process.', 'error');
        }
    }

    render() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';

        let filtered = this.ports.filter(p => {
            const matchesSearch = !this.searchQuery ||
                String(p.port).includes(this.searchQuery) ||
                (p.process && p.process.toLowerCase().includes(this.searchQuery)) ||
                (p.service && p.service.toLowerCase().includes(this.searchQuery)) ||
                (p.address && p.address.toLowerCase().includes(this.searchQuery)) ||
                (p.pid && String(p.pid).includes(this.searchQuery));

            if (!matchesSearch) return false;

            if (this.filter === 'tcp') return p.protocol === 'TCP';
            if (this.filter === 'udp') return p.protocol === 'UDP';
            if (this.filter === 'public') return p.is_public;
            if (this.filter === 'local') return !p.is_public;
            return true;
        });

        if (filtered.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="6" style="text-align:center; color:var(--text-dim); padding:2.5rem;">
                No listening ports match current filters.
            </td>`;
            this.tableBody.appendChild(tr);
            return;
        }

        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;

        filtered.forEach(p => {
            const tr = document.createElement('tr');
            const isTcp = p.protocol === 'TCP';
            const protoBadge = isTcp ? 'badge-active' : 'badge-paused';

            let accessBadge = p.is_public
                ? `<span class="badge" style="background:rgba(239,68,68,0.15); color:var(--accent-red); border:1px solid rgba(239,68,68,0.3); font-size:0.7rem;">🌐 Public</span>`
                : `<span class="badge badge-inactive" style="font-size:0.7rem;">🔒 Localhost</span>`;

            const fullBind = `${p.address}:${p.port}`;
            const procSafe = (p.process || 'kernel').replace(/"/g, '&quot;');
            const srvSafe = (p.service || procSafe).replace(/"/g, '&quot;');

            let killButton = '';
            if (isOperator && p.pid > 0) {
                killButton = `
                    <button class="btn-action danger" data-port-action="kill-pid" data-pid="${p.pid}" data-proc="${procSafe}" title="Kill owning process (PID ${p.pid})" style="padding:2px 8px; font-size:0.72rem;">
                        ⚡ Kill
                    </button>
                `;
            }

            tr.innerHTML = `
                <td>
                    <span class="badge ${protoBadge}" style="font-weight:700;">${p.protocol}</span>
                </td>
                <td>
                    <span style="font-family:var(--font-mono); font-weight:700; font-size:0.95rem; color:var(--accent-cyan);">${p.port}</span>
                </td>
                <td>
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                        <span style="font-family:var(--font-mono); font-size:0.82rem; color:var(--text-main);">${p.address}</span>
                        ${accessBadge}
                    </div>
                </td>
                <td>
                    <div style="font-weight:600; color:var(--text-main); font-size:0.88rem;">${srvSafe}</div>
                    <div style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-dim);">${procSafe}</div>
                </td>
                <td>
                    ${p.pid > 0 
                        ? `<span style="font-family:var(--font-mono); font-size:0.82rem; color:var(--accent-purple); font-weight:600;">${p.pid}</span>`
                        : `<span style="color:var(--text-dim); font-size:0.78rem;">Kernel</span>`}
                </td>
                <td style="text-align:right;">
                    <div class="btn-group" style="justify-content:flex-end; gap:4px;">
                        <button class="btn-action" data-port-action="copy" data-port="${fullBind}" title="Copy bind address" style="padding:2px 8px; font-size:0.72rem;">
                            📋 Copy
                        </button>
                        ${killButton}
                    </div>
                </td>
            `;
            this.tableBody.appendChild(tr);
        });
    }
}

// Global initialization
window.portsMgr = null;
document.addEventListener('DOMContentLoaded', () => {
    window.portsMgr = new PortsManager();
});
