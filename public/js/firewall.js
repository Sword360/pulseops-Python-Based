/* ==========================================================================
   PulseOps - Enterprise Firewall & Network Security Rules Manager Module
   Provides firewall rule inspection, real-time filtering, port opening,
   blocking, and engine management (firewalld, UFW, iptables).
   ========================================================================== */

function _authFirewallFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class FirewallManager {
    constructor() {
        this.data = null;
        this.rules = [];
        this.filter = 'all'; // 'all' | 'allow' | 'deny' | 'port' | 'service'
        this.searchQuery = '';
        this.pendingDeleteRule = null;

        this.initDOM();
    }

    initDOM() {
        this.tableBody = document.getElementById('firewall-table-body');
        this.searchInput = document.getElementById('firewall-search');
        this.filterBtns = document.querySelectorAll('[data-firewall-filter]');
        this.refreshBtn = document.getElementById('firewall-refresh-btn');
        this.reloadBtn = document.getElementById('firewall-reload-engine-btn');
        this.addRuleBtn = document.getElementById('firewall-add-rule-btn');

        // Status badges
        this.statusBadgeEl = document.getElementById('firewall-status-badge');
        this.engineBadgeEl = document.getElementById('firewall-engine-badge');
        this.zoneBadgeEl = document.getElementById('firewall-zone-badge');
        this.policyBadgeEl = document.getElementById('firewall-policy-badge');

        // Counters
        this.countTotalEl = document.getElementById('firewall-count-total');
        this.countAllowEl = document.getElementById('firewall-count-allow');
        this.countDenyEl = document.getElementById('firewall-count-deny');

        // Modal elements
        this.modal = document.getElementById('add-firewall-rule-modal');
        this.modalForm = document.getElementById('add-firewall-rule-form');
        this.modalCancelBtn = document.getElementById('cancel-add-firewall-rule-btn');

        // Delete Confirm Modal
        this.deleteModal = document.getElementById('delete-firewall-rule-modal');
        this.deleteConfirmBtn = document.getElementById('confirm-delete-firewall-rule-btn');
        this.deleteCancelBtn = document.getElementById('cancel-delete-firewall-rule-btn');
        this.deleteTargetDescEl = document.getElementById('delete-firewall-target-desc');

        // Event listeners
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
                    this.filter = btn.dataset.firewallFilter || 'all';
                    this.render();
                });
            });
        }

        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => {
                this.loadFirewall(true);
            });
        }

        if (this.reloadBtn) {
            this.reloadBtn.addEventListener('click', () => {
                this.reloadFirewallEngine();
            });
        }

        if (this.addRuleBtn) {
            this.addRuleBtn.addEventListener('click', () => {
                this.openAddModal();
            });
        }

        if (this.modalCancelBtn) {
            this.modalCancelBtn.addEventListener('click', () => {
                this.closeAddModal();
            });
        }

        if (this.modalForm) {
            this.modalForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitAddRule();
            });
        }

        if (this.deleteCancelBtn) {
            this.deleteCancelBtn.addEventListener('click', () => {
                this.closeDeleteModal();
            });
        }

        if (this.deleteConfirmBtn) {
            this.deleteConfirmBtn.addEventListener('click', () => {
                this.confirmDeleteRule();
            });
        }

        // Table action delegation
        if (this.tableBody) {
            this.tableBody.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-firewall-action]');
                if (!btn) return;
                const action = btn.dataset.firewallAction;
                const ruleId = btn.dataset.ruleId;
                const rule = this.rules.find(r => r.id === ruleId);

                if (action === 'delete') {
                    this.promptDelete(rule || { id: ruleId });
                } else if (action === 'copy') {
                    const txt = btn.dataset.copyText || '';
                    if (txt) {
                        window.copyToClipboard(txt, `Copied ${txt} to clipboard!`);
                    }
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

    async loadFirewall(showFeedback = false) {
        const sId = this._getCurrentServerId();
        const hostname = this._getCurrentServerHostname();

        if (showFeedback && window.showToast) {
            window.showToast(`Inspecting firewall on ${hostname}...`, 'info', 2000);
        }

        if (this.tableBody && (!this.rules || this.rules.length === 0)) {
            this.tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:2.5rem;">
                <span class="spinner-sm" style="display:inline-block; margin-right:8px;">⏳</span> Inspecting firewall rules on <strong>${hostname}</strong>...
            </td></tr>`;
        }

        try {
            const url = `/api/firewall/status?server_id=${encodeURIComponent(sId)}`;
            const res = await _authFirewallFetch(url);

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
            this.rules = Array.isArray(data.rules) ? data.rules : [];
            this.updateHeaderBadges(data);
            this.render();

            if (showFeedback && window.showToast) {
                window.showToast(`Firewall rules refreshed (${this.rules.length} active rules)`, 'success', 2000);
            }
        } catch (err) {
            console.error('[Firewall] Error loading firewall status:', err);
            const sId = this._getCurrentServerId();
            if (sId !== 'local-master' && (err.message.includes('Cannot connect to agent') || err.message.includes('Connect call failed'))) {
                this._renderOfflineAgentCard(hostname, sId);
            } else {
                if (this.tableBody) {
                    this.tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--accent-red); padding:2rem;">
                        ⚠️ Failed to load firewall rules: ${this._escape(err.message)}
                        <br><button class="btn btn-sm btn-secondary" style="margin-top:10px;" onclick="window.firewallMgr.loadFirewall(true)">🔄 Retry Inspection</button>
                    </td></tr>`;
                }
                if (showFeedback && window.showToast) {
                    window.showToast(`Error: ${err.message}`, 'error');
                }
            }
        }
    }

    _renderOfflineAgentCard(hostname, sId) {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = `<tr><td colspan="7" style="padding: 2rem 1rem;">
            <div class="agent-offline-card" style="max-width: 680px; margin: 0 auto; background: rgba(239, 68, 68, 0.06); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 12px; padding: 1.75rem; text-align: left;">
                <div style="display: flex; align-items: flex-start; gap: 1rem;">
                    <div style="font-size: 2rem; line-height: 1;">🛡️</div>
                    <div style="flex: 1;">
                        <h4 style="margin: 0 0 0.5rem 0; color: #fca5a5; font-size: 1.1rem; font-weight: 600;">
                            Remote Agent Offline on ${this._escape(hostname)}
                        </h4>
                        <p style="margin: 0 0 1rem 0; color: var(--text-dim); font-size: 0.88rem; line-height: 1.5;">
                            Cannot query the firewall on <strong>${this._escape(hostname)}</strong> because the PulseOps Enterprise Agent service is stopped or unreachable on port 3501.
                        </p>
                        <div style="background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1.25rem; font-family: monospace; font-size: 0.82rem; color: #a5f3fc; display: flex; align-items: center; justify-content: space-between;">
                            <span>sudo systemctl restart pulseops-agent</span>
                            <button class="btn btn-sm btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="window.copyToClipboard('sudo systemctl restart pulseops-agent', 'Copied restart command to clipboard!');">📋 Copy</button>
                        </div>
                        <div style="display: flex; gap: 0.75rem;">
                            <button class="btn btn-sm btn-primary" onclick="window.firewallMgr.loadFirewall(true)">🔄 Retry Connection</button>
                            <button class="btn btn-sm btn-secondary" onclick="window.PulseOpsApp && window.PulseOpsApp.selectServer('local-master')">← Back to Master Server</button>
                        </div>
                    </div>
                </div>
            </div>
        </td></tr>`;
    }

    updateHeaderBadges(data) {
        const active = data.active !== false;
        const backend = data.backend || 'unknown';
        const zone = data.zone || 'public';
        const policy = data.default_policy || 'DROP';

        if (this.statusBadgeEl) {
            this.statusBadgeEl.className = active ? 'badge badge-success' : 'badge badge-danger';
            this.statusBadgeEl.innerHTML = active
                ? '<span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#10b981; margin-right:4px; box-shadow:0 0 8px #10b981;"></span> ACTIVE'
                : '<span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#ef4444; margin-right:4px;"></span> INACTIVE';
        }

        if (this.engineBadgeEl) {
            this.engineBadgeEl.textContent = `Engine: ${backend.toUpperCase()}`;
            this.engineBadgeEl.title = `Active firewall backend: ${backend}`;
        }

        if (this.zoneBadgeEl) {
            this.zoneBadgeEl.textContent = `Zone: ${zone}`;
        }

        if (this.policyBadgeEl) {
            this.policyBadgeEl.textContent = `Default: ${policy}`;
            this.policyBadgeEl.className = policy === 'DROP' ? 'badge badge-warning' : 'badge badge-info';
        }
    }

    render() {
        if (!this.tableBody) return;

        let filtered = [...this.rules];

        // Action / Type Filters
        if (this.filter === 'allow') {
            filtered = filtered.filter(r => (r.action || '').toUpperCase() === 'ALLOW');
        } else if (this.filter === 'deny') {
            filtered = filtered.filter(r => ['DENY', 'REJECT'].includes((r.action || '').toUpperCase()));
        } else if (this.filter === 'port') {
            filtered = filtered.filter(r => r.type === 'port');
        } else if (this.filter === 'service') {
            filtered = filtered.filter(r => r.type === 'service');
        }

        // Search Filter
        if (this.searchQuery) {
            const q = this.searchQuery;
            filtered = filtered.filter(r => {
                return (r.port && String(r.port).toLowerCase().includes(q)) ||
                       (r.service && r.service.toLowerCase().includes(q)) ||
                       (r.source && r.source.toLowerCase().includes(q)) ||
                       (r.protocol && r.protocol.toLowerCase().includes(q)) ||
                       (r.action && r.action.toLowerCase().includes(q)) ||
                       (r.description && r.description.toLowerCase().includes(q));
            });
        }

        // Counters
        const totalCount = this.rules.length;
        const allowCount = this.rules.filter(r => (r.action || '').toUpperCase() === 'ALLOW').length;
        const denyCount = this.rules.filter(r => ['DENY', 'REJECT'].includes((r.action || '').toUpperCase())).length;

        if (this.countTotalEl) this.countTotalEl.textContent = totalCount;
        if (this.countAllowEl) this.countAllowEl.textContent = allowCount;
        if (this.countDenyEl) this.countDenyEl.textContent = denyCount;

        if (filtered.length === 0) {
            this.tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:2.5rem;">
                No firewall rules match your filter criteria.
            </td></tr>`;
            return;
        }

        const isOperator = !window.PulseOpsAuth || PulseOpsAuth.hasRole('operator');

        this.tableBody.innerHTML = filtered.map(rule => {
            const act = (rule.action || 'ALLOW').toUpperCase();
            let actionBadge = '';
            if (act === 'ALLOW') {
                actionBadge = '<span class="badge badge-success" style="font-weight:700; letter-spacing:0.5px; box-shadow:0 0 10px rgba(16,185,129,0.2);">ALLOW</span>';
            } else if (act === 'DENY') {
                actionBadge = '<span class="badge badge-danger" style="font-weight:700; letter-spacing:0.5px; box-shadow:0 0 10px rgba(239,68,68,0.2);">DENY</span>';
            } else {
                actionBadge = '<span class="badge badge-warning" style="font-weight:700; letter-spacing:0.5px;">REJECT</span>';
            }

            const proto = (rule.protocol || 'TCP').toUpperCase();
            const protoBadge = `<span class="badge" style="background:rgba(99,102,241,0.15); color:#a5b4fc; font-family:monospace;">${this._escape(proto)}</span>`;

            const portDisplay = rule.port ? `<strong style="color:var(--text-primary); font-size:0.95rem; font-family:monospace;">${this._escape(rule.port)}</strong>` : '<span style="color:var(--text-dim);">any</span>';

            const svcDisplay = rule.service
                ? `<span class="badge" style="background:rgba(56,189,248,0.12); color:#38bdf8; font-weight:500; margin-left:6px;">${this._escape(rule.service)}</span>`
                : '';

            const src = rule.source || '0.0.0.0/0';
            const isPublic = src === '0.0.0.0/0' || src.toLowerCase() === 'any' || src === '::/0';
            const srcDisplay = isPublic
                ? `<span class="badge" style="background:rgba(245,158,11,0.12); color:#fbbf24; font-family:monospace; font-size:0.75rem;">🌐 Anywhere</span>`
                : `<span class="badge" style="background:rgba(148,163,184,0.15); color:#cbd5e1; font-family:monospace; font-size:0.75rem;">🔒 ${this._escape(src)}</span>`;

            const typeLabel = rule.type === 'service' ? 'Service' : (rule.type === 'rich' ? 'Rich Rule' : 'Port');
            const typeBadge = `<span style="font-size:0.75rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px;">${typeLabel}</span>`;

            const desc = rule.description ? this._escape(rule.description) : '<span style="color:var(--text-dim); font-size:0.8rem;">—</span>';

            const deleteBtn = isOperator
                ? `<button class="btn btn-sm btn-danger-action" data-firewall-action="delete" data-rule-id="${this._escape(rule.id)}" title="Delete firewall rule" style="padding:0.25rem 0.6rem; font-size:0.75rem;">🗑️ Delete</button>`
                : '';

            return `<tr>
                <td>${actionBadge}</td>
                <td>
                    <div style="display:flex; align-items:center; gap:4px;">
                        ${portDisplay}
                        ${svcDisplay}
                    </div>
                </td>
                <td>${protoBadge}</td>
                <td>${srcDisplay}</td>
                <td>${typeBadge}</td>
                <td style="max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${this._escape(rule.description || '')}">${desc}</td>
                <td style="text-align:right;">
                    <div style="display:flex; justify-content:flex-end; gap:6px;">
                        <button class="btn btn-sm btn-secondary" data-firewall-action="copy" data-copy-text="${this._escape(rule.port || rule.service || '')}" title="Copy port/service" style="padding:0.25rem 0.5rem; font-size:0.75rem;">📋</button>
                        ${deleteBtn}
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    openAddModal() {
        if (this.modal) {
            this.modal.style.display = 'flex';
            const portInput = document.getElementById('firewall-new-port');
            if (portInput) {
                portInput.focus();
            }
        }
    }

    closeAddModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
        if (this.modalForm) {
            this.modalForm.reset();
        }
    }

    async submitAddRule() {
        const sId = this._getCurrentServerId();
        const port = document.getElementById('firewall-new-port')?.value.trim();
        const proto = document.getElementById('firewall-new-proto')?.value.trim() || 'tcp';
        const action = document.getElementById('firewall-new-action')?.value.trim() || 'ALLOW';
        const source = document.getElementById('firewall-new-source')?.value.trim() || '0.0.0.0/0';
        const desc = document.getElementById('firewall-new-desc')?.value.trim() || '';

        if (!port) {
            if (window.showToast) window.showToast('Please enter a port or port range (e.g. 8080 or 8000-8080)', 'warning');
            return;
        }

        const payload = {
            server_id: sId,
            port: port,
            protocol: proto,
            action: action,
            source: source,
            description: desc
        };

        const submitBtn = document.getElementById('submit-add-firewall-rule-btn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Applying Rule...';
        }

        try {
            const res = await _authFirewallFetch('/api/firewall/rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || data.error || `HTTP ${res.status}`);
            }

            if (window.showToast) {
                window.showToast(data.message || `Firewall rule for port ${port}/${proto.toUpperCase()} applied!`, 'success');
            }
            this.closeAddModal();
            this.loadFirewall(false);
        } catch (err) {
            console.error('[Firewall] Failed to add rule:', err);
            if (window.showToast) {
                window.showToast(`Failed to add rule: ${err.message}`, 'error');
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Add Rule';
            }
        }
    }

    promptDelete(rule) {
        this.pendingDeleteRule = rule;
        if (this.deleteTargetDescEl) {
            const desc = rule.port ? `Port ${rule.port}/${(rule.protocol || 'TCP').toUpperCase()}` : (rule.service || rule.id);
            this.deleteTargetDescEl.textContent = `${desc} (${rule.action || 'ALLOW'})`;
        }
        if (this.deleteModal) {
            this.deleteModal.style.display = 'flex';
        }
    }

    closeDeleteModal() {
        this.pendingDeleteRule = null;
        if (this.deleteModal) {
            this.deleteModal.style.display = 'none';
        }
    }

    async confirmDeleteRule() {
        if (!this.pendingDeleteRule) return;
        const rule = this.pendingDeleteRule;
        const sId = this._getCurrentServerId();

        const payload = {
            server_id: sId,
            id: rule.id,
            type: rule.type,
            port: rule.port,
            protocol: rule.protocol,
            service: rule.service,
            raw: rule.raw
        };

        if (this.deleteConfirmBtn) {
            this.deleteConfirmBtn.disabled = true;
            this.deleteConfirmBtn.textContent = 'Deleting...';
        }

        try {
            const res = await _authFirewallFetch('/api/firewall/rules/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || data.error || `HTTP ${res.status}`);
            }

            if (window.showToast) {
                window.showToast(data.message || 'Firewall rule removed successfully', 'success');
            }
            this.closeDeleteModal();
            this.loadFirewall(false);
        } catch (err) {
            console.error('[Firewall] Delete error:', err);
            if (window.showToast) {
                window.showToast(`Failed to delete rule: ${err.message}`, 'error');
            }
        } finally {
            if (this.deleteConfirmBtn) {
                this.deleteConfirmBtn.disabled = false;
                this.deleteConfirmBtn.textContent = 'Confirm Delete';
            }
        }
    }

    async reloadFirewallEngine() {
        const sId = this._getCurrentServerId();
        const hostname = this._getCurrentServerHostname();

        if (window.showToast) {
            window.showToast(`Reloading firewall ruleset on ${hostname}...`, 'info', 2000);
        }

        try {
            const res = await _authFirewallFetch('/api/firewall/reload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server_id: sId })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || data.error || `HTTP ${res.status}`);
            }

            if (window.showToast) {
                window.showToast(data.message || 'Firewall reloaded successfully!', 'success');
            }
            this.loadFirewall(false);
        } catch (err) {
            console.error('[Firewall] Reload error:', err);
            if (window.showToast) {
                window.showToast(`Reload failed: ${err.message}`, 'error');
            }
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
    window.firewallMgr = new FirewallManager();
});
