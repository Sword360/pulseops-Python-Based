/* ==========================================================================
   PulseOps - Process Manager Module
   ========================================================================== */

function _authProcFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class ProcessManager {
    constructor() {
        this.processes = [];
        this.searchQuery = '';
        this.sortBy = 'cpu'; // 'cpu' | 'mem' | 'pid'

        this.initDOM();
    }

    initDOM() {
        this.tableBody = document.getElementById('processes-table-body');
        this.searchInput = document.getElementById('proc-search');
        this.sortSelect = document.getElementById('proc-sort-select');
        this.procCountEl = document.getElementById('proc-count-total');

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase();
                this.render();
            });
        }

        if (this.sortSelect) {
            this.sortSelect.addEventListener('change', (e) => {
                this.sortBy = e.target.value;
                this.render();
            });
        }

        if (this.tableBody) {
            this.tableBody.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-kill-pid]');
                if (btn) {
                    const pid = parseInt(btn.dataset.killPid, 10);
                    const comm = btn.dataset.killComm;
                    if (pid) this.killProcess(pid, comm);
                }
            });
        }

        this.loadProcesses();
    }

    async loadProcesses() {
        const sId = window.PulseOpsCurrentServer || 'local-master';
        const hostname = window.PulseOpsCurrentServerHostname || (sId === 'local-master' ? 'Master' : 'Remote Node');

        try {
            const res = await _authProcFetch(`/api/processes?server_id=${encodeURIComponent(sId)}`);
            const data = await res.json();

            if (data.need_update) {
                if (this.procCountEl) this.procCountEl.textContent = '0';
                if (this.tableBody) {
                    const upgradeCmd = `curl -sSL ${window.location.origin}/api/fleet/agent-update.sh | sudo bash`;
                    this.tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 3rem 1.5rem;">
                        <div style="max-width: 580px; margin: 0 auto; background: var(--bg-card); border: 1px solid var(--accent-cyan); border-radius: 8px; padding: 1.5rem; text-align: left;">
                            <div style="font-size: 1.1rem; font-weight: 700; color: var(--accent-cyan); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                                🚀 Upgrade Agent to Manage Remote Processes
                            </div>
                            <p style="color: var(--text-secondary); font-size: 0.88rem; line-height: 1.5; margin-bottom: 1rem;">
                                The PulseOps agent on <strong>${hostname}</strong> is running in telemetry-only mode. Run this command on the remote machine to unlock live process inspection and termination:
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
                const rawList = data.processes || [];
                // Defensive normalization for processes from any agent version or master
                this.processes = rawList.map(p => {
                    const pid = parseInt(p.pid, 10) || 0;
                    const comm = p.comm || p.name || (p.command ? p.command.trim().split(/\s+/)[0].split('/').pop() : '') || 'unknown';
                    const name = p.name || comm;
                    const command = p.command || p.args || comm;
                    const stat = p.stat || p.status || 'running';
                    const user = p.user || 'root';
                    const cpu = typeof p.cpu === 'number' ? p.cpu : (parseFloat(p.cpu) || 0);
                    const mem = typeof p.mem === 'number' ? p.mem : (parseFloat(p.mem) || 0);
                    const rss = p.rss != null ? Number(p.rss) : 0;
                    let rssMb = '0.0';
                    if (rss > 0) {
                        rssMb = (rss / 1024).toFixed(1);
                    } else if (mem > 0) {
                        rssMb = (mem * 16).toFixed(1);
                    }

                    return {
                        ...p,
                        pid,
                        comm,
                        name,
                        command,
                        stat,
                        user,
                        cpu,
                        mem,
                        rss,
                        rssMb
                    };
                });

                if (this.procCountEl) this.procCountEl.textContent = this.processes.length;
                this.render();
            } else if (data.error) {
                if (this.tableBody) {
                    this.tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--accent-red); padding: 2rem;">Error loading processes: ${data.error}</td></tr>`;
                }
            }
        } catch (e) {
            console.error('Failed to fetch process list:', e);
            if (this.tableBody) {
                this.tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--accent-red); padding: 2rem;">Network error fetching process list</td></tr>`;
            }
        }
    }

    async killProcess(pid, comm) {
        if (window.PulseOpsAuth && !window.PulseOpsAuth.isOperator()) {
            window.showToast && window.showToast('Permission denied: Viewer accounts cannot terminate processes', 'error');
            return;
        }
        if (!confirm(`Are you sure you want to send SIGTERM to PID ${pid} (${comm})?`)) return;
        const sId = window.PulseOpsCurrentServer || 'local-master';

        try {
            const res = await _authProcFetch('/api/processes/kill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pid, signal: '15', server_id: sId })
            });
            const data = await res.json();
            if (data.success) {
                window.showToast && window.showToast(`SIGTERM sent to PID ${pid} (${comm})`, 'success');
                this.loadProcesses();
            } else {
                window.showToast && window.showToast(data.error || 'Failed to kill process', 'error');
            }
        } catch (e) {
            window.showToast && window.showToast('Network error killing process', 'error');
        }
    }

    render() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';

        let sorted = [...this.processes];
        if (this.sortBy === 'cpu') sorted.sort((a, b) => b.cpu - a.cpu);
        else if (this.sortBy === 'mem') sorted.sort((a, b) => b.mem - a.mem);
        else if (this.sortBy === 'pid') sorted.sort((a, b) => a.pid - b.pid);

        const q = (this.searchQuery || '').toLowerCase().trim();
        let filtered = sorted;
        if (q) {
            filtered = sorted.filter(p => {
                const pidStr = (p.pid != null ? p.pid : '').toString();
                const userStr = (p.user || '').toLowerCase();
                const commStr = (p.comm || '').toLowerCase();
                const cmdStr = (p.command || '').toLowerCase();
                return pidStr.includes(q) || userStr.includes(q) || commStr.includes(q) || cmdStr.includes(q);
            });
        }

        if (filtered.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="7" style="text-align: center; color: var(--text-dim); padding: 2rem;">No matching processes found</td>`;
            this.tableBody.appendChild(tr);
            return;
        }

        const fragment = document.createDocumentFragment();
        filtered.slice(0, 100).forEach(p => {
            const tr = document.createElement('tr');

            const rssMb = p.rssMb || '0.0';
            const safeComm = (p.comm || 'unknown').replace(/"/g, '&quot;');
            const safeCmd = (p.command || p.comm || '').replace(/"/g, '&quot;');

            tr.innerHTML = `
                <td style="font-family: var(--font-mono); font-weight: 600; color: var(--accent-cyan);">${p.pid}</td>
                <td><span style="color: var(--text-muted); font-size: 0.85rem;">${p.user || 'root'}</span></td>
                <td>
                    <div style="font-weight: 600; color: ${p.cpu > 50 ? 'var(--accent-red)' : p.cpu > 20 ? 'var(--accent-amber)' : 'var(--text-main)'}">
                        ${Number(p.cpu || 0).toFixed(1)}%
                    </div>
                </td>
                <td>
                    <div style="font-weight: 600; color: ${p.mem > 30 ? 'var(--accent-red)' : 'var(--text-main)'}">
                        ${Number(p.mem || 0).toFixed(1)}% <span style="font-size: 0.75rem; color: var(--text-dim);">(${rssMb} MB)</span>
                    </div>
                </td>
                <td><span class="badge badge-inactive">${p.stat || 'running'}</span></td>
                <td>
                    <span style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-main); max-width: 280px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${safeCmd}">
                        ${safeComm}
                    </span>
                </td>
                <td>
                    ${(window.PulseOpsAuth && !window.PulseOpsAuth.isOperator()) 
                        ? `<span style="color:var(--text-dim);font-size:0.8rem;font-style:italic;">Read-only</span>` 
                        : `<button class="btn-action danger" data-kill-pid="${p.pid}" data-kill-comm="${safeComm}">Kill</button>`}
                </td>
            `;
            fragment.appendChild(tr);
        });
        this.tableBody.appendChild(fragment);
    }
}

window.procMgr = null;
document.addEventListener('DOMContentLoaded', () => {
    window.procMgr = new ProcessManager();
});
