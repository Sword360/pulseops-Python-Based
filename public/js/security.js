/* ==========================================================================
   PulseOps - Enterprise Security & Threat Intelligence Module
   Provides SSH brute-force detection, attacker triage, and 1-click IP banning.
   ========================================================================== */

function _authSecurityFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class SecurityManager {
    constructor() {
        this.data = null;
        this.filter = 'all'; // 'all' | 'failed' | 'accepted'
        this.searchQuery = '';
        this.pendingBanIp = null;

        this.initDOM();
    }

    initDOM() {
        // Metric cards
        this.failedCountEl = document.getElementById('security-stat-failed');
        this.attackersCountEl = document.getElementById('security-stat-attackers');
        this.bannedCountEl = document.getElementById('security-stat-banned');
        this.acceptedCountEl = document.getElementById('security-stat-accepted');

        // Tables
        this.attackersTableBody = document.getElementById('security-attackers-table-body');
        this.targetedUsersEl = document.getElementById('security-targeted-users-list');
        this.eventsTableBody = document.getElementById('security-events-table-body');

        // Filters and search
        this.searchInput = document.getElementById('security-search');
        this.filterBtns = document.querySelectorAll('[data-security-filter]');
        this.refreshBtn = document.getElementById('security-refresh-btn');

        // Ban Modal
        this.banModal = document.getElementById('ban-ip-modal');
        this.banIpInput = document.getElementById('ban-target-ip');
        this.banReasonInput = document.getElementById('ban-target-reason');
        this.banConfirmBtn = document.getElementById('confirm-ban-ip-btn');
        this.banCancelBtn = document.getElementById('cancel-ban-ip-btn');

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase().trim();
                this.renderEvents();
            });
        }

        if (this.filterBtns) {
            this.filterBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    this.filterBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.filter = btn.dataset.securityFilter || 'all';
                    this.renderEvents();
                });
            });
        }

        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => {
                this.loadSecurity(true);
            });
        }

        if (this.banCancelBtn) {
            this.banCancelBtn.addEventListener('click', () => {
                this.closeBanModal();
            });
        }

        if (this.banConfirmBtn) {
            this.banConfirmBtn.addEventListener('click', () => {
                this.submitBan();
            });
        }

        // Action delegation
        const handleAction = (e) => {
            const btn = e.target.closest('[data-security-action]');
            if (!btn) return;
            const action = btn.dataset.securityAction;
            const ip = btn.dataset.ip;

            if (action === 'ban') {
                this.promptBan(ip);
            } else if (action === 'unban') {
                this.unbanIp(ip);
            } else if (action === 'copy') {
                const txt = btn.dataset.copyText || ip;
                if (txt) {
                    window.copyToClipboard(txt, `Copied ${txt} to clipboard!`);
                }
            }
        };

        if (this.attackersTableBody) this.attackersTableBody.addEventListener('click', handleAction);
        if (this.eventsTableBody) this.eventsTableBody.addEventListener('click', handleAction);
    }

    _getCurrentServerId() {
        return window.PulseOpsCurrentServer || (window.PulseOpsApp ? window.PulseOpsApp.currentServerId : 'local-master');
    }

    _getCurrentServerHostname() {
        const sId = this._getCurrentServerId();
        return window.PulseOpsCurrentServerHostname || (sId === 'local-master' ? 'Master Host' : 'Remote Node');
    }

    async loadSecurity(showFeedback = false) {
        const sId = this._getCurrentServerId();
        const hostname = this._getCurrentServerHostname();

        if (showFeedback && window.showToast) {
            window.showToast(`Auditing SSH threats on ${hostname}...`, 'info', 2000);
        }

        if (this.eventsTableBody && (!this.data || !this.data.events)) {
            this.eventsTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:2.5rem;">
                <span class="spinner-sm" style="display:inline-block; margin-right:8px;">⏳</span> Auditing security events on <strong>${hostname}</strong>...
            </td></tr>`;
        }

        try {
            const url = `/api/security/threats?server_id=${encodeURIComponent(sId)}`;
            const res = await _authSecurityFetch(url);

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                const errMsg = errData.detail || `Server returned HTTP ${res.status}`;

                if (sId !== 'local-master' && (errMsg.includes('Cannot connect to agent') || errMsg.includes('Connect call failed') || res.status === 502)) {
                    this._renderOfflineAgentCard(hostname, sId);
                    return;
                }
                throw new Error(errMsg);
            }

            const data = await res.json();
            this.data = data;
            this.renderStats(data.stats || {});
            this.renderAttackers(data.attackers || []);
            this.renderTargetedUsers(data.targeted_users || []);
            this.renderEvents();

            if (showFeedback && window.showToast) {
                window.showToast(`Security audit updated: ${data.stats?.total_failed || 0} failed attempts tracked`, 'success', 2000);
            }
        } catch (err) {
            console.error('[Security] Error loading security data:', err);
            const sId = this._getCurrentServerId();
            if (sId !== 'local-master' && (err.message.includes('Cannot connect to agent') || err.message.includes('Connect call failed'))) {
                this._renderOfflineAgentCard(hostname, sId);
            } else {
                if (this.eventsTableBody) {
                    this.eventsTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--accent-red); padding:2rem;">
                        ⚠️ Failed to load security telemetry: ${this._escape(err.message)}
                    </td></tr>`;
                }
                if (showFeedback && window.showToast) {
                    window.showToast(`Error: ${err.message}`, 'error');
                }
            }
        }
    }

    _renderOfflineAgentCard(hostname, sId) {
        if (!this.eventsTableBody) return;
        this.eventsTableBody.innerHTML = `<tr><td colspan="6" style="padding: 2rem 1rem;">
            <div class="agent-offline-card" style="max-width: 680px; margin: 0 auto; background: rgba(239, 68, 68, 0.06); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 12px; padding: 1.75rem; text-align: left;">
                <div style="display: flex; align-items: flex-start; gap: 1rem;">
                    <div style="font-size: 2rem; line-height: 1;">🚨</div>
                    <div style="flex: 1;">
                        <h4 style="margin: 0 0 0.5rem 0; color: #fca5a5; font-size: 1.1rem; font-weight: 600;">
                            Remote Agent Offline on ${this._escape(hostname)}
                        </h4>
                        <p style="margin: 0 0 1rem 0; color: var(--text-dim); font-size: 0.88rem; line-height: 1.5;">
                            Cannot query auth logs on <strong>${this._escape(hostname)}</strong> because the PulseOps Enterprise Agent service is stopped or unreachable on port 3501.
                        </p>
                        <div style="background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1.25rem; font-family: monospace; font-size: 0.82rem; color: #a5f3fc; display: flex; align-items: center; justify-content: space-between;">
                            <span>sudo systemctl restart pulseops-agent</span>
                            <button class="btn btn-sm btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="window.copyToClipboard('sudo systemctl restart pulseops-agent', 'Copied restart command to clipboard!');">📋 Copy</button>
                        </div>
                        <div style="display: flex; gap: 0.75rem;">
                            <button class="btn btn-sm btn-primary" onclick="window.securityMgr.loadSecurity(true)">🔄 Retry Connection</button>
                            <button class="btn btn-sm btn-secondary" onclick="window.PulseOpsApp && window.PulseOpsApp.selectServer('local-master')">← Back to Master Server</button>
                        </div>
                    </div>
                </div>
            </div>
        </td></tr>`;
    }

    renderStats(stats) {
        if (this.failedCountEl) this.failedCountEl.textContent = stats.total_failed || 0;
        if (this.attackersCountEl) this.attackersCountEl.textContent = stats.unique_attackers || 0;
        if (this.bannedCountEl) this.bannedCountEl.textContent = stats.banned_count || 0;
        if (this.acceptedCountEl) this.acceptedCountEl.textContent = stats.total_accepted || 0;
    }

    renderAttackers(attackers) {
        if (!this.attackersTableBody) return;

        if (!attackers || attackers.length === 0) {
            this.attackersTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim); padding:2rem;">
                ✅ No brute-force threats detected in recent logs.
            </td></tr>`;
            return;
        }

        const isOperator = !window.PulseOpsAuth || PulseOpsAuth.hasRole('operator');

        this.attackersTableBody.innerHTML = attackers.map(atk => {
            const usersChips = (atk.users || []).map(u => `<span class="badge" style="background:rgba(255,255,255,0.06); font-family:monospace; font-size:0.7rem; margin-right:3px;">${this._escape(u)}</span>`).join('');

            const banBtn = isOperator ? (
                atk.is_banned
                    ? `<span class="badge badge-danger" style="box-shadow:0 0 8px rgba(239,68,68,0.3); margin-right:6px;">🔒 BANNED</span>
                       <button class="btn btn-sm btn-secondary" data-security-action="unban" data-ip="${this._escape(atk.ip)}" style="padding:0.2rem 0.5rem; font-size:0.75rem;">Unban</button>`
                    : `<button class="btn btn-sm btn-danger-action" data-security-action="ban" data-ip="${this._escape(atk.ip)}" style="padding:0.25rem 0.65rem; font-size:0.75rem;">🚫 Ban IP</button>`
            ) : '';

            return `<tr>
                <td>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <strong style="color:var(--accent-red); font-family:monospace; font-size:0.9rem;">${this._escape(atk.ip)}</strong>
                        <button class="btn btn-sm btn-secondary" data-security-action="copy" data-ip="${this._escape(atk.ip)}" title="Copy IP" style="padding:2px 5px; font-size:0.7rem;">📋</button>
                    </div>
                </td>
                <td><strong style="color:#f87171; font-family:monospace;">${atk.failures}</strong></td>
                <td><div style="display:flex; flex-wrap:wrap; gap:3px;">${usersChips || '<span style="color:var(--text-dim);">—</span>'}</div></td>
                <td style="color:var(--text-dim); font-size:0.8rem; font-family:monospace;">${this._escape(atk.last_attempt || '—')}</td>
                <td style="text-align:right;">${banBtn}</td>
            </tr>`;
        }).join('');
    }

    renderTargetedUsers(users) {
        if (!this.targetedUsersEl) return;

        if (!users || users.length === 0) {
            this.targetedUsersEl.innerHTML = `<div style="text-align:center; color:var(--text-dim); padding:1.5rem;">No targeted accounts recorded.</div>`;
            return;
        }

        const maxCount = Math.max(...users.map(u => u.count), 1);

        this.targetedUsersEl.innerHTML = users.map(u => {
            const pct = Math.round((u.count / maxCount) * 100);
            const isCritical = ['root', 'admin', 'sudo'].includes(u.user.toLowerCase());
            const badge = isCritical
                ? '<span class="badge badge-danger" style="font-size:0.65rem;">CRITICAL</span>'
                : '<span class="badge" style="background:rgba(255,255,255,0.06); font-size:0.65rem;">User</span>';

            return `<div style="margin-bottom:0.75rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:0.85rem;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <strong style="font-family:monospace; color:var(--text-primary);">${this._escape(u.user)}</strong>
                        ${badge}
                    </div>
                    <span style="font-family:monospace; color:var(--text-dim); font-size:0.8rem;">${u.count} hits</span>
                </div>
                <div class="progress-bar-bg" style="height:6px; background:rgba(255,255,255,0.05); border-radius:4px;">
                    <div style="width:${pct}%; height:100%; border-radius:4px; background:linear-gradient(90deg, #ef4444, #f59e0b);"></div>
                </div>
            </div>`;
        }).join('');
    }

    renderEvents() {
        if (!this.eventsTableBody || !this.data) return;

        let events = [...(this.data.events || [])];

        // Filter
        if (this.filter === 'failed') {
            events = events.filter(e => e.status === 'FAILED');
        } else if (this.filter === 'accepted') {
            events = events.filter(e => e.status === 'ACCEPTED');
        }

        // Search
        if (this.searchQuery) {
            const q = this.searchQuery;
            events = events.filter(e => {
                return (e.ip && e.ip.toLowerCase().includes(q)) ||
                       (e.user && e.user.toLowerCase().includes(q)) ||
                       (e.timestamp && e.timestamp.toLowerCase().includes(q));
            });
        }

        if (events.length === 0) {
            this.eventsTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:2.5rem;">
                No authentication events match your filter criteria.
            </td></tr>`;
            return;
        }

        const isOperator = !window.PulseOpsAuth || PulseOpsAuth.hasRole('operator');

        this.eventsTableBody.innerHTML = events.map(ev => {
            const isFailed = ev.status === 'FAILED';
            const statusBadge = isFailed
                ? '<span class="badge badge-danger" style="box-shadow:0 0 8px rgba(239,68,68,0.2);">FAILED</span>'
                : '<span class="badge badge-success" style="box-shadow:0 0 8px rgba(16,185,129,0.2);">ACCEPTED</span>';

            const userClass = ['root', 'admin'].includes((ev.user || '').toLowerCase()) ? 'color:#f87171;' : 'color:var(--text-primary);';

            let actionCol = '';
            if (isOperator) {
                if (ev.is_banned) {
                    actionCol = `<span class="badge badge-danger" style="font-size:0.7rem;">🔒 BANNED</span>`;
                } else if (isFailed && !['127.0.0.1', '::1', 'localhost'].includes(ev.ip)) {
                    actionCol = `<button class="btn btn-sm btn-danger-action" data-security-action="ban" data-ip="${this._escape(ev.ip)}" style="padding:0.2rem 0.55rem; font-size:0.75rem;">🚫 Ban</button>`;
                }
            }

            return `<tr>
                <td>${statusBadge}</td>
                <td style="font-family:monospace; font-size:0.8rem; color:var(--text-dim);">${this._escape(ev.timestamp)}</td>
                <td><strong style="font-family:monospace; ${userClass}">${this._escape(ev.user)}</strong></td>
                <td>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-family:monospace; color:#38bdf8;">${this._escape(ev.ip)}</span>
                        <button class="btn btn-sm btn-secondary" data-security-action="copy" data-ip="${this._escape(ev.ip)}" title="Copy IP" style="padding:2px 5px; font-size:0.7rem;">📋</button>
                    </div>
                </td>
                <td style="font-family:monospace; font-size:0.8rem; color:var(--text-dim);">${this._escape(ev.port || '22')}</td>
                <td style="text-align:right;">${actionCol}</td>
            </tr>`;
        }).join('');
    }

    promptBan(ip) {
        this.pendingBanIp = ip;
        if (this.banIpInput) this.banIpInput.value = ip;
        if (this.banReasonInput) this.banReasonInput.value = 'SSH Brute-Force Abuse';
        if (this.banModal) this.banModal.style.display = 'flex';
    }

    closeBanModal() {
        this.pendingBanIp = null;
        if (this.banModal) this.banModal.style.display = 'none';
    }

    async submitBan() {
        const ip = this.banIpInput?.value.trim() || this.pendingBanIp;
        const reason = this.banReasonInput?.value.trim() || 'SSH Brute-Force';
        const sId = this._getCurrentServerId();

        if (!ip) return;

        if (this.banConfirmBtn) {
            this.banConfirmBtn.disabled = true;
            this.banConfirmBtn.textContent = 'Enforcing Firewall Drop...';
        }

        try {
            const res = await _authSecurityFetch('/api/security/ban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip, reason, server_id: sId })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);

            if (window.showToast) {
                window.showToast(data.message || `IP ${ip} permanently blocked in firewall!`, 'success');
            }
            this.closeBanModal();
            this.loadSecurity(false);
            if (window.firewallMgr) window.firewallMgr.loadFirewall(false);
        } catch (err) {
            console.error('[Security] Ban error:', err);
            if (window.showToast) window.showToast(`Failed to ban IP: ${err.message}`, 'error');
        } finally {
            if (this.banConfirmBtn) {
                this.banConfirmBtn.disabled = false;
                this.banConfirmBtn.textContent = 'Confirm & Ban IP';
            }
        }
    }

    async unbanIp(ip) {
        const sId = this._getCurrentServerId();
        if (!confirm(`Are you sure you want to unban IP ${ip}? This will remove the firewall drop rule.`)) return;

        try {
            const res = await _authSecurityFetch('/api/security/unban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip, server_id: sId })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);

            if (window.showToast) window.showToast(data.message || `IP ${ip} unbanned.`, 'success');
            this.loadSecurity(false);
            if (window.firewallMgr) window.firewallMgr.loadFirewall(false);
        } catch (err) {
            console.error('[Security] Unban error:', err);
            if (window.showToast) window.showToast(`Failed to unban IP: ${err.message}`, 'error');
        }
    }

    _escape(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

// Auto-instantiate on DOM load
document.addEventListener('DOMContentLoaded', () => {
    window.securityMgr = new SecurityManager();
});
