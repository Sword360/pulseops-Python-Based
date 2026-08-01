/* ==========================================================================
   PulseOps - Systemd Services Management Module
   ========================================================================== */

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
    }

    async loadServices() {
        try {
            const res = await fetch('/api/services');
            const data = await res.json();
            if (data.success) {
                this.services = data.services;
                this.updateCounters();
                this.render();
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
        try {
            window.showToast && window.showToast(`Executing ${action} on ${serviceName}...`, 'info');
            const res = await fetch('/api/services/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serviceName, action })
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
        this.modalTitle.textContent = `Journalctl Logs: ${serviceName}`;
        this.modalLogsContainer.textContent = 'Loading logs...';
        this.modal.classList.add('active');

        try {
            const res = await fetch(`/api/services/${serviceName}/logs`);
            const data = await res.json();
            if (data.success) {
                this.modalLogsContainer.textContent = data.logs || 'No log entries found.';
            } else {
                this.modalLogsContainer.textContent = 'Error loading logs.';
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

            tr.innerHTML = `
                <td>
                    <div style="font-weight: 600; color: var(--text-main); font-family: var(--font-mono);">${s.name}</div>
                    <div style="font-size: 0.78rem; color: var(--text-dim); max-width: 400px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.description}</div>
                </td>
                <td><span class="badge ${badgeClass}"><span style="font-size: 10px;">●</span> ${s.active} (${s.sub})</span></td>
                <td><span style="font-size: 0.85rem; color: var(--text-muted);">${s.load}</span></td>
                <td>
                    <div class="btn-group">
                        ${isRunning ? `
                            <button class="btn-action danger" data-service="${safeName}" data-svc-action="stop">Stop</button>
                            <button class="btn-action" data-service="${safeName}" data-svc-action="restart">Restart</button>
                        ` : `
                            <button class="btn-action" data-service="${safeName}" data-svc-action="start">Start</button>
                        `}
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
