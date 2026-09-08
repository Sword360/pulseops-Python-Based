/**
 * alerts.js — PulseOps Enterprise Alerts & Notification Bell UI
 *
 * Manages the notification bell with unread count, alert dropdown panel,
 * alert rules CRUD, and real-time alert updates via WebSocket events.
 */

const AlertsManager = (() => {
    let _activeAlerts = [];
    let _alertRules   = [];
    let _unreadCount  = 0;
    let _dropdownOpen = false;

    // ── Severity Config ───────────────────────────────────────────────────────

    const SEVERITY_CONFIG = {
        critical: { cls: 'severity-critical', icon: '🔴', label: 'Critical' },
        warning:  { cls: 'severity-warning',  icon: '🟡', label: 'Warning'  },
        info:     { cls: 'severity-info',      icon: '🔵', label: 'Info'     },
    };

    function getSeverityConfig(sev) {
        return SEVERITY_CONFIG[sev] || SEVERITY_CONFIG.info;
    }

    // ── Load Active Alerts ────────────────────────────────────────────────────

    async function loadActiveAlerts() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/active');
            if (!resp || !resp.ok) return;
            _activeAlerts = await resp.json();
            _unreadCount  = _activeAlerts.length;
            updateBell();
            renderAlertDropdown();
        } catch (e) {
            console.error('[Alerts] Load error:', e);
        }
    }

    async function loadAlertRules() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/rules');
            if (!resp || !resp.ok) return;
            _alertRules = await resp.json();
            renderAlertRulesTable();
        } catch (e) {
            console.error('[Alerts] Rules load error:', e);
        }
    }

    // ── Bell Icon ─────────────────────────────────────────────────────────────

    function updateBell() {
        const badge = document.getElementById('alert-bell-badge');
        const count = document.getElementById('alert-bell-count');
        if (!badge) return;
        if (_unreadCount > 0) {
            badge.style.display = 'flex';
            count.textContent   = _unreadCount > 99 ? '99+' : _unreadCount;
        } else {
            badge.style.display = 'none';
        }
    }

    function toggleDropdown() {
        const panel = document.getElementById('alert-dropdown');
        if (!panel) return;
        _dropdownOpen = !_dropdownOpen;
        panel.style.display = _dropdownOpen ? 'block' : 'none';
        if (_dropdownOpen) {
            _unreadCount = 0;
            updateBell();
            renderAlertDropdown();
        }
    }

    // ── Alert Dropdown ────────────────────────────────────────────────────────

    function renderAlertDropdown() {
        const panel = document.getElementById('alert-dropdown-content');
        if (!panel) return;

        if (_activeAlerts.length === 0) {
            panel.innerHTML = `
                <div class="alert-dropdown-empty">
                    <div style="font-size:2rem;">✅</div>
                    <div>All systems nominal</div>
                </div>`;
            return;
        }

        panel.innerHTML = _activeAlerts.slice(0, 10).map(alert => {
            const sc = getSeverityConfig(alert.severity);
            const firedAgo = timeSince(new Date(alert.fired_at));
            return `
            <div class="alert-item ${sc.cls}">
                <div class="alert-item-icon">${sc.icon}</div>
                <div class="alert-item-body">
                    <div class="alert-item-title">${alert.rule_name || 'Alert'}</div>
                    <div class="alert-item-meta">
                        <span>${alert.metric || ''}</span>
                        ${alert.hostname ? `<span>·</span><span>${alert.hostname}</span>` : ''}
                        <span>·</span><span class="alert-item-time">${firedAgo}</span>
                    </div>
                </div>
            </div>`;
        }).join('');

        if (_activeAlerts.length > 10) {
            panel.innerHTML += `
                <div class="alert-see-all" id="alert-see-all-btn">
                    View all ${_activeAlerts.length} alerts →
                </div>`;
            document.getElementById('alert-see-all-btn')?.addEventListener('click', () => {
                showSection('alerts');
                toggleDropdown();
            });
        }
    }

    // ── Alert Rules Table ─────────────────────────────────────────────────────

    function renderAlertRulesTable() {
        const tbody = document.getElementById('alert-rules-tbody');
        if (!tbody) return;

        if (_alertRules.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">No alert rules configured</td></tr>`;
            return;
        }

        tbody.innerHTML = _alertRules.map(rule => {
            const sc = getSeverityConfig(rule.severity);
            const scope = rule.server_id ? `Server: ${rule.server_id.substring(0,8)}...` : 'Global (all servers)';
            const threshold = rule.threshold != null ? `${rule.operator} ${rule.threshold}${rule.metric.includes('percent') ? '%' : ''}` : '—';
            return `
            <tr>
                <td><strong>${rule.name}</strong></td>
                <td><code class="metric-code">${rule.metric}</code></td>
                <td class="metric-threshold">${threshold}</td>
                <td><span class="severity-badge ${sc.cls}">${sc.icon} ${sc.label}</span></td>
                <td class="rule-scope">${scope}</td>
                <td>
                    <div class="user-actions">
                        ${PulseOpsAuth.isAdmin() ? `
                        <button class="btn-user-action danger" data-action="delete-rule" data-rule-id="${rule.id}" data-name="${rule.name}" title="Delete rule">🗑️ Delete</button>
                        ` : '—'}
                    </div>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('[data-action="delete-rule"]').forEach(btn => {
            btn.addEventListener('click', () => deleteAlertRule(parseInt(btn.dataset.ruleId), btn.dataset.name));
        });

        // Update stats
        const el = document.getElementById('alert-rules-count');
        if (el) el.textContent = _alertRules.length;
        const activeEl = document.getElementById('active-alerts-count');
        if (activeEl) activeEl.textContent = _activeAlerts.length;
    }

    // ── CRUD ──────────────────────────────────────────────────────────────────

    async function submitCreateRule() {
        const name      = document.getElementById('rule-name').value.trim();
        const metric    = document.getElementById('rule-metric').value;
        const operator  = document.getElementById('rule-operator').value;
        const threshold = parseFloat(document.getElementById('rule-threshold').value);
        const severity  = document.getElementById('rule-severity').value;
        const server_id = document.getElementById('rule-server-id').value.trim() || null;
        const notify_email   = document.getElementById('rule-notify-email')?.checked || false;
        const notify_webhook = document.getElementById('rule-notify-webhook')?.checked || false;
        const webhook_url    = document.getElementById('rule-webhook-url')?.value.trim() || null;

        if (!name || !metric || !operator || isNaN(threshold)) {
            showToast('All required fields must be filled', 'error'); return;
        }

        const btn = document.getElementById('create-rule-submit-btn');
        btn.disabled = true; btn.textContent = 'Creating...';

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/rules', {
                method: 'POST',
                body: JSON.stringify({ name, metric, operator, threshold, severity, server_id, notify_email, notify_webhook, webhook_url }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Alert rule "${name}" created`, 'success');
                closeCreateRuleModal();
                loadAlertRules();
            } else {
                showToast(data.detail || data.error || 'Failed to create rule', 'error');
            }
        } catch { showToast('Network error', 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Create Rule'; }
    }

    async function deleteAlertRule(ruleId, name) {
        if (!confirm(`Delete alert rule "${name}"?`)) return;
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/alerts/rules/${ruleId}`, { method: 'DELETE' });
            if (resp && resp.ok) {
                showToast(`Rule "${name}" deleted`, 'success');
                loadAlertRules();
            } else {
                showToast('Failed to delete rule', 'error');
            }
        } catch { showToast('Network error', 'error'); }
    }

    // ── WebSocket Event Handler ───────────────────────────────────────────────

    function handleAlertEvent(payload) {
        // New alert fired — add to top of list
        if (payload.type === 'alert_fired') {
            _activeAlerts.unshift(payload.alert);
            _unreadCount++;
            updateBell();
            renderAlertDropdown();
            // Show toast notification
            const sc = getSeverityConfig(payload.alert.severity);
            showToast(`${sc.icon} Alert: ${payload.alert.rule_name}`, payload.alert.severity === 'critical' ? 'error' : 'warning');
        }
        // Alert resolved — remove from list
        if (payload.type === 'alert_resolved') {
            _activeAlerts = _activeAlerts.filter(a => a.id !== payload.alert_id);
            renderAlertDropdown();
            updateBell();
        }
    }

    // ── Time Formatting ───────────────────────────────────────────────────────

    function timeSince(date) {
        const seconds = Math.floor((Date.now() - date) / 1000);
        if (seconds < 60)   return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }

    function openCreateRuleModal() {
        const modal = document.getElementById('create-rule-modal');
        if (modal) {
            modal.classList.add('active');
            modal.style.display = 'flex';
            const nameInput = document.getElementById('rule-name');
            if (nameInput) nameInput.focus();
        }
    }

    function closeCreateRuleModal() {
        const modal = document.getElementById('create-rule-modal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.display = 'none';
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        // Bell click
        const bell = document.getElementById('alert-bell-btn');
        if (bell) bell.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(); });

        // Close dropdown on outside click
        document.addEventListener('click', (e) => {
            if (_dropdownOpen && !e.target.closest('#alert-bell-container')) {
                _dropdownOpen = false;
                const panel = document.getElementById('alert-dropdown');
                if (panel) panel.style.display = 'none';
            }
        });

        // Create rule button
        const createBtn = document.getElementById('create-rule-btn');
        if (createBtn) createBtn.addEventListener('click', openCreateRuleModal);

        // Modal close buttons
        document.querySelectorAll('[data-close-modal="create-rule-modal"]').forEach(btn => {
            btn.addEventListener('click', closeCreateRuleModal);
        });

        // Create rule submit
        const createSubmit = document.getElementById('create-rule-submit-btn');
        if (createSubmit) createSubmit.addEventListener('click', submitCreateRule);

        // Webhook URL toggle
        const webhookCheckbox = document.getElementById('rule-notify-webhook');
        if (webhookCheckbox) {
            webhookCheckbox.addEventListener('change', () => {
                const urlGroup = document.getElementById('webhook-url-group');
                if (urlGroup) urlGroup.style.display = webhookCheckbox.checked ? 'block' : 'none';
            });
        }

        // Load data
        loadActiveAlerts();
        loadAlertRules();

        // Auto-refresh every 60s
        setInterval(loadActiveAlerts, 60000);
    }

    const api = {
        init,
        loadActiveAlerts,
        loadAlertRules,
        handleAlertEvent,
        updateBell,
        openCreateRuleModal,
    };
    window.AlertsManager = api;
    window.openCreateRuleModal = openCreateRuleModal;
    return api;
})();
