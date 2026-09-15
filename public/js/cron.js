/**
 * cron.js — PulseOps Enterprise Cron & Systemd Timers Manager UI
 *
 * Provides visual inspection, scheduling, real-time manual triggers,
 * and execution auditing for crontabs and systemd timers.
 */

const CronManager = (() => {
    let _cronJobs   = [];
    let _timers     = [];
    let _history    = [];
    let _activeTab  = 'cron'; // 'cron', 'timers', 'history'

    // ── Tab Switching ─────────────────────────────────────────────────────────
    function switchTab(tabKey) {
        _activeTab = tabKey;
        document.querySelectorAll('[data-cron-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.cronTab === tabKey);
        });
        document.querySelectorAll('.cron-tab-panel').forEach(panel => {
            panel.style.display = 'none';
        });
        const target = document.getElementById(`cron-view-${tabKey}`);
        if (target) target.style.display = 'block';

        if (tabKey === 'cron') loadJobs();
        else if (tabKey === 'timers') loadTimers();
        else if (tabKey === 'history') loadHistory();
    }

    // ── Data Loaders ──────────────────────────────────────────────────────────
    async function loadAll() {
        await Promise.all([loadJobs(), loadTimers(), loadHistory()]);
    }

    async function loadJobs() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/cron/jobs');
            if (!resp || !resp.ok) return;
            _cronJobs = await resp.json();
            renderJobsTable();
            updateStats();
        } catch (e) {
            console.error('[Cron] Load jobs error:', e);
        }
    }

    async function loadTimers() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/cron/timers');
            if (!resp || !resp.ok) return;
            _timers = await resp.json();
            renderTimersTable();
            updateStats();
        } catch (e) {
            console.error('[Cron] Load timers error:', e);
        }
    }

    async function loadHistory() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/cron/history?limit=50');
            if (!resp || !resp.ok) return;
            _history = await resp.json();
            renderHistoryTable();
        } catch (e) {
            console.error('[Cron] Load history error:', e);
        }
    }

    function updateStats() {
        const jobsCountEl = document.getElementById('cron-stat-jobs-count');
        const timersCountEl = document.getElementById('cron-stat-timers-count');
        const runsCountEl = document.getElementById('cron-stat-runs-count');

        if (jobsCountEl) jobsCountEl.textContent = _cronJobs.length;
        if (timersCountEl) timersCountEl.textContent = _timers.length;
        if (runsCountEl) runsCountEl.textContent = _history.length;
    }

    // ── Render Tables ─────────────────────────────────────────────────────────
    function renderJobsTable() {
        const tbody = document.getElementById('cron-jobs-tbody');
        if (!tbody) return;

        if (_cronJobs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-table-cell">No scheduled cron jobs found on system</td></tr>`;
            return;
        }

        tbody.innerHTML = _cronJobs.map(job => {
            const isUser = job.source === 'user';
            const scopeLabel = isUser ? 'User Crontab' : `System (${job.file.split('/').pop()})`;

            return `
            <tr style="opacity: ${job.is_enabled ? '1' : '0.55'};">
                <td>
                    ${isUser ? `
                    <label class="toggle-switch" style="transform:scale(0.85);" title="Toggle job enabled/disabled">
                        <input type="checkbox" data-action="toggle-job" data-id="${job.id}" ${job.is_enabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                    ` : '<span title="Managed by system file">🔒</span>'}
                </td>
                <td>
                    <strong style="color:var(--text-main);">${escapeHtml(job.human_schedule)}</strong>
                    <div style="font-family:var(--font-mono); font-size:0.75rem; color:#38bdf8;">${escapeHtml(job.schedule)}</div>
                </td>
                <td>
                    <code class="metric-code" style="word-break:break-all; white-space:normal; display:inline-block; max-width:320px;">${escapeHtml(job.command)}</code>
                    ${job.comment ? `<div style="font-size:0.75rem; color:var(--text-dim); margin-top:0.2rem;">💬 ${escapeHtml(job.comment)}</div>` : ''}
                </td>
                <td><span style="font-family:var(--font-mono); font-size:0.8rem;">${escapeHtml(job.user)}</span></td>
                <td><span style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(scopeLabel)}</span></td>
                <td>
                    <div style="display:flex; gap:0.4rem; align-items:center;">
                        <button class="alert-action-btn test" data-action="run-job-now" data-cmd="${escapeHtml(job.command)}" title="Run command immediately">
                            ▶️ Run Now
                        </button>
                        ${isUser && PulseOpsAuth.isAdmin() ? `
                        <button class="btn-user-action danger" data-action="delete-job" data-id="${job.id}" title="Delete cron job">
                            🗑️
                        </button>
                        ` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('[data-action="toggle-job"]').forEach(cb => {
            cb.addEventListener('change', () => toggleJob(cb.dataset.id));
        });

        tbody.querySelectorAll('[data-action="run-job-now"]').forEach(btn => {
            btn.addEventListener('click', () => runCommandNow(btn.dataset.cmd));
        });

        tbody.querySelectorAll('[data-action="delete-job"]').forEach(btn => {
            btn.addEventListener('click', () => deleteJob(btn.dataset.id));
        });
    }

    function renderTimersTable() {
        const tbody = document.getElementById('cron-timers-tbody');
        if (!tbody) return;

        if (_timers.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="empty-table-cell">No active systemd timers found</td></tr>`;
            return;
        }

        tbody.innerHTML = _timers.map(timer => {
            return `
            <tr>
                <td>
                    <strong style="color:var(--accent-cyan); font-family:var(--font-mono); font-size:0.85rem;">${escapeHtml(timer.unit)}</strong>
                </td>
                <td>
                    <span style="font-family:var(--font-mono); font-size:0.82rem; color:var(--text-main);">${escapeHtml(timer.activates)}</span>
                </td>
                <td>
                    <span style="font-size:0.78rem; font-family:var(--font-mono); color:var(--text-muted);">${escapeHtml(timer.raw_line)}</span>
                </td>
                <td>
                    <div style="display:flex; gap:0.4rem; align-items:center;">
                        <button class="alert-action-btn ack" data-action="control-timer" data-unit="${escapeHtml(timer.unit)}" data-act="run_now" title="Trigger target service now">
                            ▶️ Run Target
                        </button>
                        <button class="alert-action-btn test" data-action="control-timer" data-unit="${escapeHtml(timer.unit)}" data-act="restart" title="Restart timer">
                            🔄 Restart
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('[data-action="control-timer"]').forEach(btn => {
            btn.addEventListener('click', () => controlTimer(btn.dataset.unit, btn.dataset.act));
        });
    }

    function renderHistoryTable() {
        const tbody = document.getElementById('cron-history-tbody');
        if (!tbody) return;

        if (_history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">No manual executions recorded yet</td></tr>`;
            return;
        }

        tbody.innerHTML = _history.map(entry => {
            const isOk = entry.exit_code === 0;
            const badge = isOk
                ? `<span class="triage-badge triage-badge-resolved">0 SUCCESS</span>`
                : `<span class="triage-badge triage-badge-firing">${entry.exit_code} FAILED</span>`;
            const duration = `${entry.duration_ms || 0}ms`;

            return `
            <tr>
                <td>${badge}</td>
                <td>
                    <code class="metric-code" style="max-width:320px; display:inline-block; white-space:normal;">${escapeHtml(entry.command)}</code>
                </td>
                <td><span style="font-size:0.8rem; color:var(--text-muted);">${new Date(entry.started_at).toLocaleString()}</span></td>
                <td><span style="font-size:0.8rem; font-weight:600; color:#38bdf8;">${duration}</span></td>
                <td><span style="font-size:0.8rem; color:var(--text-dim);">${escapeHtml(entry.triggered_by)}</span></td>
                <td>
                    <button class="alert-action-btn test" data-action="view-output" data-id="${entry.id}">
                        📄 Logs
                    </button>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('[data-action="view-output"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.id, 10);
                const rec = _history.find(h => h.id === id);
                if (rec) showOutputModal(rec);
            });
        });
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    async function runCommandNow(command) {
        if (!command) return;
        showToast('Executing command in background...', 'info');
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/cron/jobs/run-now', {
                method: 'POST',
                body: JSON.stringify({ command }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Command completed in ${data.duration_ms}ms (Exit 0)`, 'success');
            } else {
                showToast(`Command finished with exit code ${data.exit_code}`, 'warning');
            }
            loadHistory();
        } catch {
            showToast('Failed to execute command', 'error');
        }
    }

    async function controlTimer(unit, action) {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/cron/timers/control', {
                method: 'POST',
                body: JSON.stringify({ timer_unit: unit, action }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(data.message || `Timer ${action} successful`, 'success');
                loadTimers();
            } else {
                showToast(data.detail || data.error || 'Failed timer operation', 'error');
            }
        } catch {
            showToast('Network error during timer action', 'error');
        }
    }

    async function toggleJob(jobId) {
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/cron/jobs/${jobId}/toggle`, {
                method: 'POST',
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Cron job ${data.is_enabled ? 'enabled' : 'disabled'}`, 'info');
                loadJobs();
            } else {
                showToast(data.detail || data.error || 'Failed to toggle cron job', 'error');
            }
        } catch {
            showToast('Network error', 'error');
        }
    }

    async function deleteJob(jobId) {
        if (!confirm('Permanently delete this cron job?')) return;
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/cron/jobs/${jobId}`, {
                method: 'DELETE',
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast('Cron job deleted', 'success');
                loadJobs();
            } else {
                showToast(data.detail || data.error || 'Failed to delete cron job', 'error');
            }
        } catch {
            showToast('Network error', 'error');
        }
    }

    async function submitCreateJob() {
        const schedule = document.getElementById('create-cron-schedule')?.value.trim();
        const command = document.getElementById('create-cron-command')?.value.trim();
        const comment = document.getElementById('create-cron-comment')?.value.trim();

        if (!schedule || !command) {
            showToast('Schedule and command are required', 'warning');
            return;
        }

        const btn = document.getElementById('create-cron-submit-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/cron/jobs', {
                method: 'POST',
                body: JSON.stringify({ schedule, command, comment }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast('Cron job scheduled successfully!', 'success');
                closeCreateJobModal();
                loadJobs();
            } else {
                showToast(data.detail || data.error || 'Failed to create cron job', 'error');
            }
        } catch {
            showToast('Network error while scheduling job', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Scheduled Job'; }
        }
    }

    // ── Modals & Utilities ────────────────────────────────────────────────────
    function openCreateJobModal() {
        const modal = document.getElementById('create-cron-modal');
        if (modal) {
            modal.classList.add('active');
            modal.style.display = 'flex';
            document.getElementById('create-cron-schedule')?.focus();
        }
    }

    function closeCreateJobModal() {
        const modal = document.getElementById('create-cron-modal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.display = 'none';
        }
    }

    function showOutputModal(record) {
        const modal = document.getElementById('cron-output-modal');
        const title = document.getElementById('cron-output-title');
        const pre = document.getElementById('cron-output-content');
        if (!modal) return;

        if (title) title.textContent = `Execution: ${record.command}`;
        if (pre) {
            let out = `Exit Code: ${record.exit_code}\nDuration: ${record.duration_ms}ms\nStarted: ${record.started_at}\n\n`;
            if (record.stdout) out += `--- STDOUT ---\n${record.stdout}\n`;
            if (record.stderr) out += `--- STDERR ---\n${record.stderr}\n`;
            pre.textContent = out;
        }

        modal.classList.add('active');
        modal.style.display = 'flex';
    }

    function closeOutputModal() {
        const modal = document.getElementById('cron-output-modal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.display = 'none';
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ── Initialization ────────────────────────────────────────────────────────
    function init() {
        // Tab clicks
        document.querySelectorAll('[data-cron-tab]').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.cronTab));
        });

        // Modals
        const createBtn = document.getElementById('create-cron-btn');
        if (createBtn) createBtn.addEventListener('click', openCreateJobModal);

        document.querySelectorAll('[data-close-modal="create-cron-modal"]').forEach(btn => {
            btn.addEventListener('click', closeCreateJobModal);
        });

        document.querySelectorAll('[data-close-modal="cron-output-modal"]').forEach(btn => {
            btn.addEventListener('click', closeOutputModal);
        });

        const submitBtn = document.getElementById('create-cron-submit-btn');
        if (submitBtn) submitBtn.addEventListener('click', submitCreateJob);

        // Schedule presets click
        document.querySelectorAll('[data-cron-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById('create-cron-schedule');
                if (input) input.value = btn.dataset.cronPreset;
            });
        });

        loadAll();
    }

    const api = {
        init,
        loadAll,
        loadJobs,
        loadTimers,
        loadHistory,
        openCreateJobModal,
    };
    window.CronManager = api;
    return api;
})();
