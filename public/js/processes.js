/* ==========================================================================
   PulseOps - Process Manager Module
   ========================================================================== */

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
    }

    async loadProcesses() {
        try {
            const res = await fetch('/api/processes');
            const data = await res.json();
            if (data.success) {
                this.processes = data.processes;
                if (this.procCountEl) this.procCountEl.textContent = this.processes.length;
                this.render();
            }
        } catch (e) {
            console.error('Failed to fetch process list:', e);
        }
    }

    async killProcess(pid, comm) {
        if (!confirm(`Are you sure you want to send SIGTERM to PID ${pid} (${comm})?`)) return;

        try {
            const res = await fetch('/api/processes/kill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pid, signal: '15' })
            });
            const data = await res.json();
            if (data.success) {
                window.showToast && window.showToast(`SIGTERM sent to PID ${pid}`, 'success');
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

        let filtered = sorted.filter(p => {
            return p.pid.toString().includes(this.searchQuery) ||
                   p.user.toLowerCase().includes(this.searchQuery) ||
                   p.comm.toLowerCase().includes(this.searchQuery);
        });

        if (filtered.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="7" style="text-align: center; color: var(--text-dim); padding: 2rem;">No matching processes found</td>`;
            this.tableBody.appendChild(tr);
            return;
        }

        filtered.slice(0, 100).forEach(p => {
            const tr = document.createElement('tr');

            const rssMb = (p.rss / 1024).toFixed(1);
            const safeComm = p.comm.replace(/"/g, '&quot;');

            tr.innerHTML = `
                <td style="font-family: var(--font-mono); font-weight: 600; color: var(--accent-cyan);">${p.pid}</td>
                <td><span style="color: var(--text-muted); font-size: 0.85rem;">${p.user}</span></td>
                <td>
                    <div style="font-weight: 600; color: ${p.cpu > 50 ? 'var(--accent-red)' : p.cpu > 20 ? 'var(--accent-amber)' : 'var(--text-main)'}">
                        ${p.cpu.toFixed(1)}%
                    </div>
                </td>
                <td>
                    <div style="font-weight: 600; color: ${p.mem > 30 ? 'var(--accent-red)' : 'var(--text-main)'}">
                        ${p.mem.toFixed(1)}% <span style="font-size: 0.75rem; color: var(--text-dim);">(${rssMb} MB)</span>
                    </div>
                </td>
                <td><span class="badge badge-inactive">${p.stat}</span></td>
                <td><span style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-main);">${p.comm}</span></td>
                <td>
                    <button class="btn-action danger" data-kill-pid="${p.pid}" data-kill-comm="${safeComm}">Kill</button>
                </td>
            `;
            this.tableBody.appendChild(tr);
        });
    }
}

window.procMgr = null;
document.addEventListener('DOMContentLoaded', () => {
    window.procMgr = new ProcessManager();
});
