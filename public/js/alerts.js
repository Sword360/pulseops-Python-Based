/**
 * alerts.js — PulseOps Modern Alert & Incident Response Command Center
 *
 * Provides real-time incident monitoring, multi-channel alerting, HTML5 Web Audio
 * chimes, desktop push notifications, incident triage (acknowledge/resolve),
 * policy management, and webhook simulator.
 */

const AlertsManager = (() => {
    let _activeAlerts   = [];
    let _alertRules     = [];
    let _alertHistory   = [];
    let _unreadCount    = 0;
    let _dropdownOpen   = false;
    let _activeTab      = 'active';
    let _soundEnabled   = localStorage.getItem('pulseops_alert_sound') !== 'false';
    let _audioCtx       = null;

    // ── Metric Labels & Units Formatting ──────────────────────────────────────
    const METRIC_LABELS = {
        cpu_percent:    { label: 'CPU Usage', unit: '%' },
        mem_percent:    { label: 'Memory Usage', unit: '%' },
        disk_percent:   { label: 'Disk Usage', unit: '%' },
        swap_percent:   { label: 'Swap Usage', unit: '%' },
        load_avg_1:     { label: 'Load Avg (1m)', unit: '' },
        load_avg_15:    { label: 'Load Avg (15m)', unit: '' },
        net_rx_mb:      { label: 'Net Inbound', unit: ' MB/s' },
        net_tx_mb:      { label: 'Net Outbound', unit: ' MB/s' },
        agent_offline:  { label: 'Agent Offline', unit: '' },
        service_down:   { label: 'Service Down', unit: '' },
    };

    const SEVERITY_CONFIG = {
        critical: { cls: 'severity-critical', icon: '🔴', label: 'Critical' },
        warning:  { cls: 'severity-warning',  icon: '🟡', label: 'Warning'  },
        info:     { cls: 'severity-info',     icon: '🔵', label: 'Info'     },
    };

    function getSeverityConfig(sev) {
        return SEVERITY_CONFIG[sev] || SEVERITY_CONFIG.warning;
    }

    // ── Web Audio Chime Synthesizer ───────────────────────────────────────────
    function playChime(severity = 'warning') {
        if (!_soundEnabled) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            if (!_audioCtx || _audioCtx.state === 'suspended') {
                _audioCtx = new AudioContext();
            }

            const now = _audioCtx.currentTime;
            const osc1 = _audioCtx.createOscillator();
            const osc2 = _audioCtx.createOscillator();
            const gain = _audioCtx.createGain();

            osc1.type = 'sine';
            osc2.type = 'triangle';

            if (severity === 'critical') {
                // Urgent high-pitch double beep
                osc1.frequency.setValueAtTime(880, now);
                osc1.frequency.setValueAtTime(660, now + 0.12);
                osc2.frequency.setValueAtTime(440, now);
            } else {
                // Pleasant gentle notification chime
                osc1.frequency.setValueAtTime(523.25, now); // C5
                osc1.frequency.setValueAtTime(659.25, now + 0.1); // E5
                osc2.frequency.setValueAtTime(329.63, now); // E4
            }

            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

            osc1.connect(gain);
            osc2.connect(gain);
            gain.connect(_audioCtx.destination);

            osc1.start(now);
            osc2.start(now);
            osc1.stop(now + 0.35);
            osc2.stop(now + 0.35);
        } catch (e) {
            console.debug('[Alerts] Audio chime not allowed or failed:', e);
        }
    }

    // ── Desktop Push Notifications ────────────────────────────────────────────
    async function requestDesktopPermission() {
        if (!('Notification' in window)) {
            showToast('Browser does not support desktop notifications', 'warning');
            return;
        }
        if (Notification.permission === 'granted') {
            showToast('Desktop notifications are already enabled', 'info');
            return;
        }
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
            showToast('Desktop alerts enabled!', 'success');
            updateDesktopNotifyBtn();
        }
    }

    function sendDesktopNotification(alert) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const sev = (alert.severity || 'warning').toUpperCase();
        const server = alert.hostname || alert.server_id || 'System';
        try {
            new Notification(`🚨 [${sev}] ${alert.rule_name || 'PulseOps Alert'}`, {
                body: `${server}: ${alert.metric || 'System metric'} threshold violated.`,
                icon: '/public/favicon.ico',
            });
        } catch (e) {
            console.debug('[Alerts] Desktop notification failed:', e);
        }
    }

    function updateDesktopNotifyBtn() {
        const btn = document.getElementById('alert-desktop-notify-btn');
        if (!btn) return;
        if (window.Notification && Notification.permission === 'granted') {
            btn.innerHTML = '✅ Desktop Alerts On';
            btn.classList.add('active');
        } else {
            btn.innerHTML = '🔔 Enable Desktop Alerts';
            btn.classList.remove('active');
        }
    }

    function updateSoundToggleBtn() {
        const icon = document.getElementById('alert-sound-icon');
        const label = document.getElementById('alert-sound-label');
        if (!icon || !label) return;
        if (_soundEnabled) {
            icon.textContent = '🔊';
            label.textContent = 'Audio On';
        } else {
            icon.textContent = '🔇';
            label.textContent = 'Muted';
        }
    }

    function toggleSound() {
        _soundEnabled = !_soundEnabled;
        localStorage.setItem('pulseops_alert_sound', _soundEnabled ? 'true' : 'false');
        updateSoundToggleBtn();
        if (_soundEnabled) playChime('info');
        showToast(_soundEnabled ? 'Incident audio chime enabled' : 'Incident audio chime muted', 'info');
    }

    // ── Data Loaders & Stats ──────────────────────────────────────────────────
    async function loadStats() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/stats');
            if (!resp || !resp.ok) return;
            const s = await resp.json();

            const firingEl   = document.getElementById('alert-stat-firing');
            const ackEl      = document.getElementById('alert-stat-ack');
            const resEl      = document.getElementById('alert-stat-resolved');
            const rulesEl    = document.getElementById('alert-stat-rules');
            const tabBadgeEl = document.getElementById('alerts-badge-active-count');

            if (firingEl)   firingEl.textContent = s.firing || 0;
            if (ackEl)      ackEl.textContent = s.acknowledged || 0;
            if (resEl)      resEl.textContent = s.resolved_24h || 0;
            if (rulesEl)    rulesEl.textContent = s.rules_active || 0;

            const totalActive = (s.firing || 0) + (s.acknowledged || 0);
            if (tabBadgeEl) {
                tabBadgeEl.textContent = totalActive;
                tabBadgeEl.style.display = totalActive > 0 ? 'inline-block' : 'none';
            }

            // Update Critical Banner
            const banner = document.getElementById('alert-critical-banner');
            if (banner) {
                if ((s.critical || 0) > 0) {
                    banner.style.display = 'flex';
                    const title = document.getElementById('alert-critical-banner-title');
                    if (title) title.textContent = `${s.critical} Critical Incident${s.critical > 1 ? 's' : ''} Require Immediate Attention`;
                } else {
                    banner.style.display = 'none';
                }
            }
        } catch (e) {
            console.error('[Alerts] Error loading stats:', e);
        }
    }

    async function loadActiveAlerts() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/active');
            if (!resp || !resp.ok) return;
            _activeAlerts = await resp.json();
            _unreadCount  = _activeAlerts.length;
            updateBell();
            renderAlertDropdown();
            renderActiveIncidentsTable();
            loadStats();
        } catch (e) {
            console.error('[Alerts] Load active alerts error:', e);
        }
    }

    async function loadAlertRules() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/rules?all=1');
            if (!resp || !resp.ok) return;
            _alertRules = await resp.json();
            renderAlertRulesTable();
            loadStats();
        } catch (e) {
            console.error('[Alerts] Load alert rules error:', e);
        }
    }

    async function loadAlertHistory() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/history?limit=100');
            if (!resp || !resp.ok) return;
            _alertHistory = await resp.json();
            renderAlertHistoryTable();
        } catch (e) {
            console.error('[Alerts] Load alert history error:', e);
        }
    }

    // ── Table Renders ─────────────────────────────────────────────────────────

    function renderActiveIncidentsTable() {
        const tbody = document.getElementById('active-incidents-tbody');
        if (!tbody) return;

        if (_activeAlerts.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-table-cell" style="padding:2.5rem; text-align:center;">
                        <div style="font-size:2.2rem; margin-bottom:0.5rem;">🟢</div>
                        <strong style="color:var(--text-main); font-size:1rem;">All Monitored Nodes Nominal</strong>
                        <div style="color:var(--text-dim); font-size:0.85rem; margin-top:0.25rem;">No active alert thresholds breached across your fleet.</div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = _activeAlerts.map(alert => {
            const sc = getSeverityConfig(alert.severity);
            const firedAgo = timeSince(alert.fired_at);
            const server = alert.hostname || alert.display_name || alert.server_id || 'master-node';
            const mMeta = METRIC_LABELS[alert.metric] || { label: alert.metric, unit: '' };

            let valDisplay = alert.value != null ? `${alert.value}${mMeta.unit}` : '—';
            let threshDisplay = alert.threshold != null ? `${alert.operator || '>'} ${alert.threshold}${mMeta.unit}` : '—';

            const isAcked = !!alert.acknowledged_at;
            const triageBadge = isAcked
                ? `<span class="triage-badge triage-badge-ack" title="Acknowledged by ${alert.acknowledged_by || 'operator'}: ${alert.acknowledged_note || ''}">🟡 Acknowledged</span>`
                : `<span class="triage-badge triage-badge-firing">🔴 FIRING</span>`;

            return `
            <tr>
                <td><span class="severity-badge ${sc.cls}">${sc.icon} ${sc.label}</span></td>
                <td>
                    <strong style="color:var(--text-main);">${escapeHtml(alert.rule_name || 'Alert')}</strong>
                    <div style="font-size:0.75rem; color:var(--text-dim); font-family:var(--font-mono);">${alert.metric}</div>
                </td>
                <td>
                    <span style="font-family:var(--font-mono); font-size:0.82rem; font-weight:600; color:#38bdf8;">${escapeHtml(server)}</span>
                </td>
                <td>
                    <strong style="color:${sc.cls === 'severity-critical' ? '#ef4444' : '#fbbf24'};">${valDisplay}</strong>
                    <span style="color:var(--text-dim); font-size:0.78rem;">(limit ${threshDisplay})</span>
                </td>
                <td><span style="font-size:0.8rem; color:var(--text-muted);">${firedAgo}</span></td>
                <td>${triageBadge}</td>
                <td>
                    <div style="display:flex; gap:0.4rem; align-items:center;">
                        ${!isAcked ? `
                        <button class="alert-action-btn ack" data-action="ack-alert" data-id="${alert.id}" data-name="${escapeHtml(alert.rule_name || '')}" data-server="${escapeHtml(server)}" title="Acknowledge incident">
                            🟡 Ack
                        </button>
                        ` : ''}
                        <button class="alert-action-btn resolve" data-action="resolve-alert" data-id="${alert.id}" title="Mark incident resolved">
                            🟢 Resolve
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('[data-action="ack-alert"]').forEach(btn => {
            btn.addEventListener('click', () => {
                openAckModal(btn.dataset.id, `${btn.dataset.name} on ${btn.dataset.server}`);
            });
        });

        tbody.querySelectorAll('[data-action="resolve-alert"]').forEach(btn => {
            btn.addEventListener('click', () => {
                resolveAlert(btn.dataset.id);
            });
        });
    }

    function renderAlertRulesTable() {
        const tbody = document.getElementById('alert-rules-tbody');
        if (!tbody) return;

        if (_alertRules.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-table-cell">No alert rules configured</td></tr>`;
            return;
        }

        tbody.innerHTML = _alertRules.map(rule => {
            const sc = getSeverityConfig(rule.severity);
            const mMeta = METRIC_LABELS[rule.metric] || { label: rule.metric, unit: '' };
            const scope = rule.server_id ? (rule.server_hostname || rule.server_id.substring(0, 10)) : 'Global (All Hosts)';
            
            let conditionText = '—';
            if (rule.metric === 'agent_offline') {
                conditionText = 'Heartbeat lost';
            } else if (rule.metric === 'service_down') {
                conditionText = `Unit ${rule.target_service || 'service'} down`;
            } else if (rule.threshold != null) {
                conditionText = `${rule.operator || '>'} ${rule.threshold}${mMeta.unit}`;
            }

            const channels = [];
            if (rule.notify_email) channels.push('📧 Email');
            if (rule.notify_webhook) channels.push(`🚀 ${rule.channel_type || 'Webhook'}`);
            const channelStr = channels.length ? channels.join(', ') : '<span style="color:var(--text-dim);">None</span>';

            const isActive = rule.is_active !== 0;

            return `
            <tr style="opacity:${isActive ? 1 : 0.6};">
                <td>
                    <label class="toggle-switch" style="transform:scale(0.85);">
                        <input type="checkbox" data-action="toggle-rule" data-id="${rule.id}" ${isActive ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </td>
                <td>
                    <strong style="color:var(--text-main); font-size:0.88rem;">${escapeHtml(rule.name)}</strong>
                </td>
                <td>
                    <code class="metric-code">${rule.metric}</code>
                    <span style="margin-left:0.35rem; font-weight:600; font-size:0.8rem;">${conditionText}</span>
                </td>
                <td><span class="severity-badge ${sc.cls}">${sc.icon} ${sc.label}</span></td>
                <td><span style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(scope)}</span></td>
                <td><span style="font-size:0.8rem;">${channelStr}</span></td>
                <td>
                    <div style="display:flex; gap:0.4rem; align-items:center;">
                        <button class="alert-action-btn test" data-action="test-rule" data-id="${rule.id}" title="Simulate and test rule notification">
                            🚀 Test
                        </button>
                        ${PulseOpsAuth.isAdmin() ? `
                        <button class="btn-user-action danger" data-action="delete-rule" data-id="${rule.id}" data-name="${escapeHtml(rule.name)}" title="Delete rule">
                            🗑️
                        </button>
                        ` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('[data-action="toggle-rule"]').forEach(input => {
            input.addEventListener('change', () => toggleRule(input.dataset.id));
        });

        tbody.querySelectorAll('[data-action="test-rule"]').forEach(btn => {
            btn.addEventListener('click', () => testRule(btn.dataset.id));
        });

        tbody.querySelectorAll('[data-action="delete-rule"]').forEach(btn => {
            btn.addEventListener('click', () => deleteRule(btn.dataset.id, btn.dataset.name));
        });
    }

    function renderAlertHistoryTable() {
        const tbody = document.getElementById('alert-history-tbody');
        if (!tbody) return;

        if (_alertHistory.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-table-cell">No past incidents recorded</td></tr>`;
            return;
        }

        tbody.innerHTML = _alertHistory.map(alert => {
            const sc = getSeverityConfig(alert.severity);
            const dFired = parseDate(alert.fired_at);
            const dResolved = parseDate(alert.resolved_at);
            const firedAt = dFired ? dFired.toLocaleString() : '—';
            const resolvedAt = dResolved ? dResolved.toLocaleString() : '<span style="color:#ef4444; font-weight:600;">Active Now</span>';

            let duration = '—';
            if (dFired && dResolved) {
                const diffMs = dResolved.getTime() - dFired.getTime();
                const secs = Math.max(0, Math.floor(diffMs / 1000));
                if (secs < 60) duration = `${secs}s`;
                else if (secs < 3600) duration = `${Math.floor(secs / 60)}m ${secs % 60}s`;
                else duration = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
            }

            return `
            <tr>
                <td><span class="severity-badge ${sc.cls}">${sc.icon} ${sc.label}</span></td>
                <td><span style="font-family:var(--font-mono); font-size:0.8rem; color:#38bdf8;">${escapeHtml(server)}</span></td>
                <td><strong>${escapeHtml(alert.rule_name || 'Incident')}</strong></td>
                <td><code class="metric-code">${alert.metric || ''}</code></td>
                <td><span style="font-size:0.78rem; color:var(--text-muted);">${firedAt}</span></td>
                <td><span style="font-size:0.78rem; color:var(--text-muted);">${resolvedAt}</span></td>
                <td><span style="font-weight:600; font-size:0.8rem; color:#10b981;">${duration}</span></td>
            </tr>`;
        }).join('');
    }

    // ── Incident Actions (Ack, Resolve, Toggle, Test, Delete) ──────────────────

    function openAckModal(alertId, summary) {
        const modal = document.getElementById('ack-incident-modal');
        const idInput = document.getElementById('ack-alert-id');
        const infoEl = document.getElementById('ack-incident-info');
        const noteInput = document.getElementById('ack-incident-note');
        if (!modal) return;
        if (idInput) idInput.value = alertId;
        if (infoEl) infoEl.textContent = `Target: ${summary}`;
        if (noteInput) noteInput.value = '';
        modal.classList.add('active');
        modal.style.display = 'flex';
    }

    function closeAckModal() {
        const modal = document.getElementById('ack-incident-modal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.display = 'none';
        }
    }

    async function submitAckAlert() {
        const alertId = document.getElementById('ack-alert-id')?.value;
        const note = document.getElementById('ack-incident-note')?.value.trim();
        if (!alertId) return;

        const btn = document.getElementById('ack-incident-submit-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Acknowledging...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/alerts/active/${alertId}/ack`, {
                method: 'POST',
                body: JSON.stringify({ note }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast('Incident acknowledged', 'success');
                closeAckModal();
                loadActiveAlerts();
            } else {
                showToast(data.detail || data.error || 'Failed to acknowledge incident', 'error');
            }
        } catch {
            showToast('Network error while acknowledging', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Confirm Acknowledgment'; }
        }
    }

    async function resolveAlert(alertId) {
        if (!confirm('Mark this incident as resolved?')) return;
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/alerts/active/${alertId}/resolve`, {
                method: 'POST',
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast('Incident marked resolved', 'success');
                loadActiveAlerts();
                loadAlertHistory();
            } else {
                showToast(data.detail || data.error || 'Failed to resolve incident', 'error');
            }
        } catch {
            showToast('Network error while resolving', 'error');
        }
    }

    async function toggleRule(ruleId) {
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/alerts/rules/${ruleId}/toggle`, {
                method: 'POST',
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Rule "${data.name}" ${data.is_active ? 'enabled' : 'disabled'}`, 'info');
                loadAlertRules();
            } else {
                showToast(data.detail || 'Failed to toggle rule', 'error');
            }
        } catch {
            showToast('Network error', 'error');
        }
    }

    async function testRule(ruleId) {
        try {
            showToast('Dispatching test notification...', 'info');
            const resp = await PulseOpsAuth.apiFetch(`/api/alerts/rules/${ruleId}/test`, {
                method: 'POST',
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(data.message || 'Test notification sent!', 'success');
            } else {
                showToast(data.detail || data.error || 'Failed to test rule', 'error');
            }
        } catch {
            showToast('Network error while testing rule', 'error');
        }
    }

    async function deleteRule(ruleId, name) {
        if (!confirm(`Delete alert policy "${name}"?`)) return;
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/alerts/rules/${ruleId}`, {
                method: 'DELETE',
            });
            if (resp && resp.ok) {
                showToast(`Rule "${name}" deleted`, 'success');
                loadAlertRules();
            } else {
                showToast('Failed to delete rule', 'error');
            }
        } catch {
            showToast('Network error', 'error');
        }
    }

    async function testSimulatorWebhook() {
        const channelType = document.getElementById('simulator-channel-type')?.value || 'webhook';
        const url = document.getElementById('simulator-webhook-url')?.value.trim();
        const statusText = document.getElementById('simulator-status-text');
        const respBox = document.getElementById('simulator-response-box');

        if (!url) {
            showToast('Please provide a webhook URL to test', 'warning');
            return;
        }

        const btn = document.getElementById('simulator-send-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Testing...'; }
        if (statusText) { statusText.innerHTML = '<span style="color:#38bdf8;">Connecting to endpoint...</span>'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/test-webhook', {
                method: 'POST',
                body: JSON.stringify({ webhook_url: url, channel_type: channelType }),
            });
            const data = await resp.json();

            if (resp.ok && data.success) {
                if (statusText) statusText.innerHTML = `<span style="color:#10b981; font-weight:700;">✅ Success! HTTP ${data.status} (${data.latency_ms}ms)</span>`;
                if (respBox) {
                    respBox.style.display = 'block';
                    respBox.innerHTML = `<span style="color:#34d399;">Test notification successfully delivered to ${escapeHtml(channelType)} in ${data.latency_ms}ms. Check your destination channel!</span>`;
                }
                showToast('Webhook payload delivered successfully!', 'success');
            } else {
                if (statusText) statusText.innerHTML = `<span style="color:#ef4444; font-weight:700;">❌ Delivery Failed (HTTP ${data.status || 'ERR'})</span>`;
                if (respBox) {
                    respBox.style.display = 'block';
                    respBox.innerHTML = `<span style="color:#f87171;">Endpoint error: ${escapeHtml(data.error || data.detail || 'Connection refused')}</span>`;
                }
                showToast('Webhook delivery failed', 'error');
            }
        } catch (e) {
            if (statusText) statusText.innerHTML = `<span style="color:#ef4444;">Network error</span>`;
            showToast('Network request failed', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🚀 Send Test Alert'; }
        }
    }

    async function submitCreateRule() {
        const name           = document.getElementById('rule-name')?.value.trim();
        const metric         = document.getElementById('rule-metric')?.value;
        const operator       = document.getElementById('rule-operator')?.value;
        const threshold      = parseFloat(document.getElementById('rule-threshold')?.value);
        const severity       = document.getElementById('rule-severity')?.value;
        const server_id      = document.getElementById('rule-server-id')?.value.trim() || null;
        const target_service = document.getElementById('rule-target-service')?.value.trim() || null;
        const cooldown       = parseInt(document.getElementById('rule-cooldown')?.value || '15', 10);
        const notify_email   = document.getElementById('rule-notify-email')?.checked || false;
        const notify_webhook = document.getElementById('rule-notify-webhook')?.checked || false;
        const channel_type   = document.getElementById('rule-channel-type')?.value || 'webhook';
        const webhook_url    = document.getElementById('rule-webhook-url')?.value.trim() || null;

        if (!name) {
            showToast('Rule policy name is required', 'warning'); return;
        }

        if (metric === 'service_down' && !target_service) {
            showToast('Please specify the target systemd service name', 'warning'); return;
        }

        if (metric !== 'agent_offline' && metric !== 'service_down' && isNaN(threshold)) {
            showToast('Please specify a valid numeric threshold', 'warning'); return;
        }

        const btn = document.getElementById('create-rule-submit-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving Policy...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/alerts/rules', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    metric,
                    operator,
                    threshold: isNaN(threshold) ? 0 : threshold,
                    severity,
                    server_id,
                    target_service,
                    cooldown_minutes: cooldown,
                    notify_email,
                    notify_webhook,
                    channel_type,
                    webhook_url,
                }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Alert policy "${name}" saved!`, 'success');
                closeCreateRuleModal();
                loadAlertRules();
            } else {
                showToast(data.detail || data.error || 'Failed to save alert rule', 'error');
            }
        } catch {
            showToast('Network error while creating rule', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Alert Policy'; }
        }
    }

    // ── WebSocket Real-Time Event Dispatcher ──────────────────────────────────
    function handleAlertEvent(payload) {
        if (!payload) return;

        if (payload.type === 'alert_fired') {
            const alert = payload.alert;
            _activeAlerts = _activeAlerts.filter(a => a.id !== alert.id);
            _activeAlerts.unshift(alert);
            _unreadCount++;

            playChime(alert.severity);
            sendDesktopNotification(alert);

            const sc = getSeverityConfig(alert.severity);
            showToast(`${sc.icon} [${sc.label.toUpperCase()}] Alert: ${alert.rule_name}`, alert.severity === 'critical' ? 'error' : 'warning');

            // Trigger alert bell chime animation
            const bellBtn = document.getElementById('alert-bell-btn');
            if (bellBtn) {
                bellBtn.classList.remove('bell-ringing');
                void bellBtn.offsetWidth;
                bellBtn.classList.add('bell-ringing');
                setTimeout(() => bellBtn.classList.remove('bell-ringing'), 2400);
            }

            updateBell();
            renderAlertDropdown();
            renderActiveIncidentsTable();
            loadStats();
        } else if (payload.type === 'alert_acknowledged') {
            const idx = _activeAlerts.findIndex(a => a.id === payload.alert_id);
            if (idx !== -1) {
                _activeAlerts[idx].acknowledged_at = payload.acknowledged_at;
                _activeAlerts[idx].acknowledged_by = payload.acknowledged_by;
                _activeAlerts[idx].acknowledged_note = payload.note;
                renderActiveIncidentsTable();
                renderAlertDropdown();
                loadStats();
            }
        } else if (payload.type === 'alert_resolved') {
            _activeAlerts = _activeAlerts.filter(a => a.id !== payload.alert_id);
            updateBell();
            renderAlertDropdown();
            renderActiveIncidentsTable();
            loadStats();
            loadAlertHistory();
        }
    }

    // ── UI Navigation & Modals ────────────────────────────────────────────────
    function switchTab(tabKey) {
        _activeTab = tabKey;
        document.querySelectorAll('[data-alert-tab]').forEach(btn => {
            const isActive = btn.dataset.alertTab === tabKey;
            btn.classList.toggle('active', isActive);
            if (isActive) {
                btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
            }
        });
        document.querySelectorAll('.alert-tab-panel').forEach(panel => {
            panel.style.display = 'none';
        });
        const target = document.getElementById(`alerts-view-${tabKey}`);
        if (target) target.style.display = 'block';

        if (tabKey === 'rules') loadAlertRules();
        else if (tabKey === 'history') loadAlertHistory();
        else if (tabKey === 'active') loadActiveAlerts();
    }

    function updateBell() {
        const badge = document.getElementById('alert-bell-badge');
        const count = document.getElementById('alert-bell-count');
        if (!badge) return;
        if (_unreadCount > 0) {
            badge.style.display = 'flex';
            count.textContent = _unreadCount > 99 ? '99+' : _unreadCount;
        } else {
            badge.style.display = 'none';
        }
    }

    function toggleDropdown() {
        const panel = document.getElementById('alert-dropdown');
        if (!panel) return;
        _dropdownOpen = !_dropdownOpen;
        if (_dropdownOpen) {
            const userDd = document.getElementById('user-dropdown');
            if (userDd) userDd.style.display = 'none';
        }
        panel.style.display = _dropdownOpen ? 'block' : 'none';
        if (_dropdownOpen) {
            _unreadCount = 0;
            updateBell();
            renderAlertDropdown();
        }
    }

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
            const firedAgo = timeSince(alert.fired_at);
            const server = alert.hostname || alert.display_name || alert.server_id || 'master-node';
            return `
            <div class="alert-item ${sc.cls}">
                <div class="alert-item-icon">${sc.icon}</div>
                <div class="alert-item-body">
                    <div class="alert-item-title">${escapeHtml(alert.rule_name || 'Alert')}</div>
                    <div class="alert-item-meta">
                        <span>${alert.metric || ''}</span>
                        <span>·</span><span>${escapeHtml(server)}</span>
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

    function openCreateRuleModal() {
        const modal = document.getElementById('create-rule-modal');
        if (modal) {
            modal.classList.add('active');
            modal.style.display = 'flex';
            document.getElementById('rule-name')?.focus();
        }
    }

    function closeCreateRuleModal() {
        const modal = document.getElementById('create-rule-modal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.display = 'none';
        }
    }

    function parseDate(dateInput) {
        if (!dateInput) return null;
        if (dateInput instanceof Date) return isNaN(dateInput.getTime()) ? null : dateInput;
        let s = String(dateInput).trim();
        if (!s) return null;
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
            s = s.replace(' ', 'T');
        }
        if (!s.endsWith('Z') && !/[+-]\d{2}:?\d{2}$/.test(s)) {
            s += 'Z';
        }
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }

    function timeSince(dateInput) {
        const date = parseDate(dateInput);
        if (!date) return 'just now';
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
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
        // Bell icon
        const bell = document.getElementById('alert-bell-btn');
        if (bell) bell.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(); });

        document.addEventListener('click', (e) => {
            if (_dropdownOpen && !e.target.closest('#alert-bell-container')) {
                _dropdownOpen = false;
                const panel = document.getElementById('alert-dropdown');
                if (panel) panel.style.display = 'none';
            }
        });

        // Tabs
        document.querySelectorAll('[data-alert-tab]').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.alertTab));
        });

        // Audio & Desktop Controls
        const soundBtn = document.getElementById('alert-sound-toggle-btn');
        if (soundBtn) soundBtn.addEventListener('click', toggleSound);
        updateSoundToggleBtn();

        const notifyBtn = document.getElementById('alert-desktop-notify-btn');
        if (notifyBtn) notifyBtn.addEventListener('click', requestDesktopPermission);
        updateDesktopNotifyBtn();

        // Simulator
        const simSendBtn = document.getElementById('simulator-send-btn');
        if (simSendBtn) simSendBtn.addEventListener('click', testSimulatorWebhook);

        // Modal triggers
        const createBtn = document.getElementById('create-rule-btn');
        if (createBtn) createBtn.addEventListener('click', openCreateRuleModal);

        document.querySelectorAll('[data-close-modal="create-rule-modal"]').forEach(btn => {
            btn.addEventListener('click', closeCreateRuleModal);
        });

        const createSubmit = document.getElementById('create-rule-submit-btn');
        if (createSubmit) createSubmit.addEventListener('click', submitCreateRule);

        // Dynamic form inputs
        const metricSelect = document.getElementById('rule-metric');
        if (metricSelect) {
            metricSelect.addEventListener('change', () => {
                const val = metricSelect.value;
                const svcGroup = document.getElementById('rule-target-service-group');
                const opGroup = document.getElementById('rule-operator-group');
                const threshGroup = document.getElementById('rule-threshold-group');

                if (val === 'service_down') {
                    if (svcGroup) svcGroup.style.display = 'block';
                    if (opGroup) opGroup.style.display = 'none';
                    if (threshGroup) threshGroup.style.display = 'none';
                } else if (val === 'agent_offline') {
                    if (svcGroup) svcGroup.style.display = 'none';
                    if (opGroup) opGroup.style.display = 'none';
                    if (threshGroup) threshGroup.style.display = 'none';
                } else {
                    if (svcGroup) svcGroup.style.display = 'none';
                    if (opGroup) opGroup.style.display = 'block';
                    if (threshGroup) threshGroup.style.display = 'block';
                }
            });
        }

        const webhookCheckbox = document.getElementById('rule-notify-webhook');
        if (webhookCheckbox) {
            webhookCheckbox.addEventListener('change', () => {
                const urlGroup = document.getElementById('webhook-url-group');
                if (urlGroup) urlGroup.style.display = webhookCheckbox.checked ? 'block' : 'none';
            });
        }

        // Acknowledge Modal
        document.querySelectorAll('[data-close-modal="ack-incident-modal"]').forEach(btn => {
            btn.addEventListener('click', closeAckModal);
        });
        const ackSubmit = document.getElementById('ack-incident-submit-btn');
        if (ackSubmit) ackSubmit.addEventListener('click', submitAckAlert);

        // Initial Data Fetch
        loadActiveAlerts();
        loadAlertRules();

        // Polling sync
        setInterval(loadActiveAlerts, 20000);
    }

    const api = {
        init,
        loadActiveAlerts,
        loadAlertRules,
        loadAlertHistory,
        loadStats,
        handleAlertEvent,
        updateBell,
        openCreateRuleModal,
        openAckModal,
        resolveAlert,
        toggleSound,
        switchTab,
    };
    window.AlertsManager = api;
    window.openCreateRuleModal = openCreateRuleModal;
    return api;
})();
