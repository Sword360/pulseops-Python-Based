/* ==========================================================================
   PulseOps - Systemd Services Management Module
   ========================================================================== */

function _authFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class SystemdServiceManager {
    constructor() {
        this.services = [];
        this.filter = 'all';
        this.searchQuery = '';

        this.initDOM();
    }

    initDOM() {
        this.tableBody = document.getElementById('services-table-body');
        this.searchInput = document.getElementById('service-search');
        this.filterBtns = document.querySelectorAll('#services-tab .btn-filter');
        this.totalCountEl = document.getElementById('service-count-total');
        this.runningCountEl = document.getElementById('service-count-running');
        this.failedCountEl = document.getElementById('service-count-failed');

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase();
                this.render();
            });
        }

        if (this.filterBtns) {
            this.filterBtns.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    this.filterBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.filter = btn.dataset.filter || 'all';
                    this.render();
                });
            });
        }

        // Service log modal elements
        this.modal = document.getElementById('log-modal');
        this.modalClose = document.getElementById('modal-close-btn');
        this.modalLogsContainer = document.getElementById('modal-log-content');
        this.modalTitle = document.getElementById('modal-service-title');

        if (this.modalClose) {
            this.modalClose.addEventListener('click', () => {
                this.modal.classList.remove('active');
            });
        }
        if (this.tableBody) {
            this.tableBody.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-svc-action]');
                if (btn) {
                    const service = btn.dataset.service;
                    const action = btn.dataset.svcAction;
                    if (action === 'logs') {
                        this.openLogsModal(service);
                    } else {
                        this.executeAction(service, action);
                    }
                }
            });
        }

        // Initial load
        this.loadServices();
    }

    async loadServices() {
        const sId = window.PulseOpsCurrentServer || 'local-master';
        const hostname = window.PulseOpsCurrentServerHostname || (sId === 'local-master' ? 'Master' : 'Remote Node');

        try {
            const res = await _authFetch(`/api/services?server_id=${encodeURIComponent(sId)}`);
            const data = await res.json();

            if (data.need_update) {
                this.services = [];
                this.updateCounters();
                if (this.tableBody) {
                    const upgradeCmd = `curl -sSL ${window.location.origin}/api/fleet/agent-update.sh | sudo bash`;
                    this.tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding: 3rem 1.5rem;">
                        <div style="max-width: 580px; margin: 0 auto; background: var(--bg-card); border: 1px solid var(--accent-cyan); border-radius: 8px; padding: 1.5rem; text-align: left;">
                            <div style="font-size: 1.1rem; font-weight: 700; color: var(--accent-cyan); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                                🚀 Upgrade Agent to Manage Remote Services
                            </div>
                            <p style="color: var(--text-secondary); font-size: 0.88rem; line-height: 1.5; margin-bottom: 1rem;">
                                The PulseOps agent on <strong>${hostname}</strong> is running in telemetry-only mode. Run this command on the remote machine to unlock systemd service controls and live journalctl logs:
                            </p>
                            <div style="background: rgba(0,0,0,0.6); border: 1px solid var(--border-color); padding: 0.75rem 1rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.82rem; color: var(--accent-green); display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
                                <span style="word-break: break-all;">${upgradeCmd}</span>
                                <button class="btn btn-sm btn-primary" style="white-space: nowrap;" onclick="navigator.clipboard.writeText('${upgradeCmd}'); window.showToast('Copied upgrade command to clipboard!', 'success');">Copy Command</button>
                            </div>
                        </div>
                    </td></tr>`;
                }
                return;
            }

            if (data.success) {
                this.services = data.services || [];
                this.updateCounters();
                this.render();
            } else if (data.error) {
                if (this.tableBody) {
                    this.tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--accent-red); padding: 2rem;">Error: ${data.error}</td></tr>`;
                }
            }
        } catch (e) {
            console.error('Failed to load systemd services:', e);
        }
    }

    updateCounters() {
        const total = this.services.length;
        const running = this.services.filter(s => s.active === 'active' && s.sub === 'running').length;
        const failed = this.services.filter(s => s.active === 'failed').length;

        if (this.totalCountEl) this.totalCountEl.textContent = total;
        if (this.runningCountEl) this.runningCountEl.textContent = running;
        if (this.failedCountEl) this.failedCountEl.textContent = failed;
    }

    async executeAction(serviceName, action) {
        if (action !== 'logs' && window.PulseOpsAuth && !window.PulseOpsAuth.isOperator()) {
            window.showToast && window.showToast('Permission denied: Viewer accounts cannot modify systemd services', 'error');
            return;
        }
        const sId = window.PulseOpsCurrentServer || 'local-master';
        try {
            window.showToast && window.showToast(`Executing ${action} on ${serviceName}...`, 'info');
            const res = await _authFetch('/api/services/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serviceName, action, server_id: sId })
            });
            const data = await res.json();
            if (data.success) {
                window.showToast && window.showToast(`Service ${serviceName} ${action}ed successfully`, 'success');
                this.loadServices();
            } else {
                window.showToast && window.showToast(data.message || data.error || 'Action failed', 'error');
            }
        } catch (e) {
            window.showToast && window.showToast('Network error executing action', 'error');
        }
    }

    async openLogsModal(serviceName) {
        if (!this.modal) return;
        const sId = window.PulseOpsCurrentServer || 'local-master';
        this.modalTitle.textContent = `Journalctl Logs: ${serviceName}`;
        this.modalLogsContainer.textContent = 'Loading logs...';
        this.modal.classList.add('active');

        try {
            const res = await _authFetch(`/api/services/${encodeURIComponent(serviceName)}/logs?server_id=${encodeURIComponent(sId)}`);
            const data = await res.json();
            if (data.success) {
                this.modalLogsContainer.textContent = data.logs || 'No log entries found.';
            } else {
                this.modalLogsContainer.textContent = data.error || 'Error loading logs.';
            }
        } catch (e) {
            this.modalLogsContainer.textContent = 'Failed to fetch service logs.';
        }
    }

    render() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';

        let filtered = this.services.filter(s => {
            const matchesSearch = s.name.toLowerCase().includes(this.searchQuery) || 
                                  s.description.toLowerCase().includes(this.searchQuery);

            if (!matchesSearch) return false;

            if (this.filter === 'active') return s.active === 'active' && s.sub === 'running';
            if (this.filter === 'failed') return s.active === 'failed';
            if (this.filter === 'inactive') return s.active === 'inactive' || s.sub === 'dead';
            return true;
        });

        if (filtered.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="4" style="text-align: center; color: var(--text-dim); padding: 2rem;">No matching services found</td>`;
            this.tableBody.appendChild(tr);
            return;
        }

        filtered.forEach(s => {
            const tr = document.createElement('tr');

            let badgeClass = 'badge-inactive';
            if (s.active === 'active' && s.sub === 'running') badgeClass = 'badge-active';
            else if (s.active === 'failed') badgeClass = 'badge-failed';

            const isRunning = s.active === 'active' && s.sub === 'running';

            const safeName = s.name.replace(/"/g, '&quot;');
            const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;
            let controlButtons = '';
            if (isOperator) {
                if (isRunning) {
                    controlButtons = `
                        <button class="btn-action danger" data-service="${safeName}" data-svc-action="stop">Stop</button>
                        <button class="btn-action" data-service="${safeName}" data-svc-action="restart">Restart</button>
                    `;
                } else {
                    controlButtons = `
                        <button class="btn-action" data-service="${safeName}" data-svc-action="start">Start</button>
                    `;
                }
            }

            tr.innerHTML = `
                <td>
                    <div style="font-weight: 600; color: var(--text-main); font-family: var(--font-mono);">${s.name}</div>
                    <div style="font-size: 0.78rem; color: var(--text-dim); max-width: 400px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.description}</div>
                </td>
                <td><span class="badge ${badgeClass}"><span style="font-size: 10px;">●</span> ${s.active} (${s.sub})</span></td>
                <td><span style="font-size: 0.85rem; color: var(--text-muted);">${s.load}</span></td>
                <td>
                    <div class="btn-group">
                        ${controlButtons}
                        <button class="btn-action" data-service="${safeName}" data-svc-action="logs">Logs</button>
                    </div>
                </td>
            `;
            this.tableBody.appendChild(tr);
        });
    }
}

window.systemdMgr = null;
document.addEventListener('DOMContentLoaded', () => {
    window.systemdMgr = new SystemdServiceManager();
});
