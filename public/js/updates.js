/**
 * PulseOps Enterprise — Real-Time Linux Infrastructure Management
 * ============================================================================
 * Module:      updates.js
 * Description: OS package updates center, security CVE advisories, reboot status, and live package patching.
 *
 * @author      Najmul Islam
 * @developer   Najmul Islam
 * @contact     f2pnajmul@gmail.com
 * @license     MIT License (see LICENSE file for details)
 * @copyright   (c) 2026 Najmul Islam. All rights reserved.
 * ============================================================================
 */

const UpdatesManager = (() => {
    let _updatesData = null;
    let _history     = [];
    let _activeTab   = 'packages'; // 'packages', 'history'

    function switchTab(tabKey) {
        _activeTab = tabKey;
        document.querySelectorAll('[data-updates-tab]').forEach(btn => {
            const isActive = btn.dataset.updatesTab === tabKey;
            btn.classList.toggle('active', isActive);
            if (isActive) {
                btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
            }
        });
        document.querySelectorAll('.updates-tab-panel').forEach(panel => {
            panel.style.display = 'none';
        });
        const target = document.getElementById(`updates-view-${tabKey}`);
        if (target) target.style.display = 'block';

        if (tabKey === 'packages') loadUpdates();
        else if (tabKey === 'history') loadHistory();
    }

    async function loadUpdates(forceRefresh = false) {
        const refreshBtn = document.getElementById('updates-refresh-btn');
        if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = 'Checking...'; }

        try {
            const url = forceRefresh ? '/api/updates/status?refresh=1' : '/api/updates/status';
            const resp = await PulseOpsAuth.apiFetch(url);
            if (!resp || !resp.ok) return;
            _updatesData = await resp.json();
            renderUpdatesView();
            updateSidebarBadge();
        } catch (e) {
            console.error('[Updates] Error checking updates:', e);
        } finally {
            if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 Check for Updates'; }
        }
    }

    async function loadHistory() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/updates/history?limit=20');
            if (!resp || !resp.ok) return;
            _history = await resp.json();
            renderHistoryTable();
        } catch (e) {
            console.error('[Updates] Error loading history:', e);
        }
    }

    function updateSidebarBadge() {
        const badge = document.getElementById('sidebar-updates-badge');
        if (!badge || !_updatesData) return;
        const count = _updatesData.total_updates || 0;
        if (count > 0) {
            badge.style.display = 'inline-block';
            badge.textContent = count;
            badge.style.background = (_updatesData.security_updates > 0) ? '#ef4444' : '#f59e0b';
        } else {
            badge.style.display = 'none';
        }
    }

    function renderUpdatesView() {
        if (!_updatesData) return;

        // KPI Stats
        const totalEl   = document.getElementById('updates-stat-total');
        const secEl     = document.getElementById('updates-stat-security');
        const rebootEl  = document.getElementById('updates-stat-reboot');
        const mgrEl     = document.getElementById('updates-stat-manager');

        if (totalEl) totalEl.textContent = _updatesData.total_updates || 0;
        if (secEl) {
            secEl.textContent = _updatesData.security_updates || 0;
            secEl.style.color = (_updatesData.security_updates > 0) ? '#ef4444' : '#10b981';
        }
        if (mgrEl) {
            mgrEl.textContent = (_updatesData.package_manager || 'UNKNOWN').toUpperCase();
        }

        // Reboot banner
        const rebootBanner = document.getElementById('updates-reboot-banner');
        const rebootInfo = _updatesData.reboot_info || {};
        if (rebootBanner) {
            if (rebootInfo.reboot_required) {
                rebootBanner.style.display = 'flex';
                const reasonEl = document.getElementById('updates-reboot-reason');
                if (reasonEl) reasonEl.textContent = rebootInfo.reason || 'Reboot required to apply kernel/core patches.';
            } else {
                rebootBanner.style.display = 'none';
            }
        }
        if (rebootEl) {
            rebootEl.textContent = rebootInfo.reboot_required ? 'REBOOT NEEDED' : 'CLEAN';
            rebootEl.style.color = rebootInfo.reboot_required ? '#ef4444' : '#10b981';
        }

        // Packages Table
        const tbody = document.getElementById('updates-packages-tbody');
        if (!tbody) return;

        const packages = _updatesData.packages || [];
        if (packages.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-table-cell" style="padding:2.5rem; text-align:center;">
                        <div style="font-size:2.2rem; margin-bottom:0.5rem;">🛡️</div>
                        <strong style="color:var(--text-main); font-size:1.05rem;">Operating System Fully Up to Date</strong>
                        <div style="color:var(--text-dim); font-size:0.85rem; margin-top:0.25rem;">No pending security or package updates for this host.</div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = packages.map(pkg => {
            const isSec = pkg.type === 'security';
            const badge = isSec
                ? `<span class="triage-badge triage-badge-firing">🚨 SECURITY CVE</span>`
                : `<span class="severity-badge severity-info">🔵 GENERAL</span>`;

            return `
            <tr>
                <td>${badge}</td>
                <td>
                    <strong style="color:var(--text-main); font-size:0.88rem;">${escapeHtml(pkg.name)}</strong>
                    ${pkg.arch ? `<span style="font-size:0.75rem; color:var(--text-dim); margin-left:0.35rem; font-family:var(--font-mono);">${escapeHtml(pkg.arch)}</span>` : ''}
                </td>
                <td>
                    <span style="font-family:var(--font-mono); font-size:0.82rem; font-weight:600; color:#38bdf8;">${escapeHtml(pkg.version)}</span>
                </td>
                <td>
                    <span style="font-size:0.78rem; font-family:var(--font-mono); color:var(--text-muted);">${escapeHtml(pkg.repository || 'repo')}</span>
                </td>
                <td>
                    <span style="font-size:0.8rem; color:var(--text-dim);">${isSec ? 'Recommended Immediate' : 'Standard'}</span>
                </td>
            </tr>`;
        }).join('');
    }

    function renderHistoryTable() {
        const tbody = document.getElementById('updates-history-tbody');
        if (!tbody) return;

        if (_history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-table-cell">No previous upgrade sessions recorded</td></tr>`;
            return;
        }

        tbody.innerHTML = _history.map(item => {
            const isOk = item.status === 'completed';
            const badge = isOk
                ? `<span class="triage-badge triage-badge-resolved">COMPLETED</span>`
                : (item.status === 'running' ? `<span class="triage-badge triage-badge-ack">RUNNING</span>` : `<span class="triage-badge triage-badge-firing">FAILED</span>`);

            return `
            <tr>
                <td>${badge}</td>
                <td><span style="font-size:0.82rem;">${new Date(item.started_at).toLocaleString()}</span></td>
                <td><span style="font-size:0.8rem; color:var(--text-muted);">${item.finished_at ? new Date(item.finished_at).toLocaleTimeString() : 'In-Progress'}</span></td>
                <td><span style="font-size:0.8rem; color:var(--text-dim);">${escapeHtml(item.initiated_by)}</span></td>
                <td>
                    <button class="alert-action-btn test" data-action="view-upgrade-log" data-id="${item.id}">
                        📄 View Log
                    </button>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('[data-action="view-upgrade-log"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.id, 10);
                const rec = _history.find(h => h.id === id);
                if (rec) showLogModal(rec);
            });
        });
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    async function executeUpgrade(dryRun = false, securityOnly = false) {
        const actionName = dryRun ? 'Dry Run Simulation' : (securityOnly ? 'Security Patches Upgrade' : 'Full OS Upgrade');
        if (!dryRun && !confirm(`Proceed with ${actionName} on this system?`)) return;

        const modal = document.getElementById('upgrade-progress-modal');
        const titleEl = document.getElementById('upgrade-modal-title');
        const logBox = document.getElementById('upgrade-modal-output');
        const doneBtn = document.getElementById('upgrade-modal-done-btn');

        if (titleEl) titleEl.textContent = `Executing: ${actionName}`;
        if (logBox) logBox.textContent = `[${new Date().toISOString()}] Initiating ${actionName}...\nExecuting package manager command in background...\n`;
        if (doneBtn) doneBtn.disabled = true;
        if (modal) { modal.classList.add('active'); modal.style.display = 'flex'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/updates/upgrade', {
                method: 'POST',
                body: JSON.stringify({ dry_run: dryRun, security_only: securityOnly }),
            });
            const data = await resp.json();

            if (resp.ok && data.success) {
                if (logBox) logBox.textContent += `\n[COMPLETED in ${data.duration_secs}s]\n\n${data.log}`;
                showToast(`${actionName} completed successfully!`, 'success');
            } else {
                if (logBox) logBox.textContent += `\n[FAILED]\n\n${data.error || data.detail || 'Execution error'}`;
                showToast(`${actionName} failed`, 'error');
            }
            loadUpdates(true);
            loadHistory();
        } catch (e) {
            if (logBox) logBox.textContent += `\n[NETWORK ERROR]\n${e}`;
            showToast('Network error during upgrade', 'error');
        } finally {
            if (doneBtn) doneBtn.disabled = false;
        }
    }

    function showLogModal(record) {
        const modal = document.getElementById('upgrade-progress-modal');
        const titleEl = document.getElementById('upgrade-modal-title');
        const logBox = document.getElementById('upgrade-modal-output');
        const doneBtn = document.getElementById('upgrade-modal-done-btn');

        if (titleEl) titleEl.textContent = `Upgrade Session Log #${record.id} (${record.status.toUpperCase()})`;
        if (logBox) logBox.textContent = record.log_output || 'No output log recorded.';
        if (doneBtn) doneBtn.disabled = false;
        if (modal) { modal.classList.add('active'); modal.style.display = 'flex'; }
    }

    function closeProgressModal() {
        const modal = document.getElementById('upgrade-progress-modal');
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

    function init() {
        // Tab clicks
        document.querySelectorAll('[data-updates-tab]').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.updatesTab));
        });

        const refreshBtn = document.getElementById('updates-refresh-btn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => loadUpdates(true));

        const dryRunBtn = document.getElementById('updates-dry-run-btn');
        if (dryRunBtn) dryRunBtn.addEventListener('click', () => executeUpgrade(true, false));

        const secBtn = document.getElementById('updates-sec-upgrade-btn');
        if (secBtn) secBtn.addEventListener('click', () => executeUpgrade(false, true));

        const fullBtn = document.getElementById('updates-full-upgrade-btn');
        if (fullBtn) fullBtn.addEventListener('click', () => executeUpgrade(false, false));

        document.querySelectorAll('[data-close-modal="upgrade-progress-modal"]').forEach(btn => {
            btn.addEventListener('click', closeProgressModal);
        });

        loadUpdates(false);
    }

    const api = {
        init,
        loadUpdates,
        loadHistory,
        executeUpgrade,
    };
    window.UpdatesManager = api;
    return api;
})();
