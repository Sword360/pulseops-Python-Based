/**
 * PulseOps Enterprise — Real-Time Linux Infrastructure Management
 * ============================================================================
 * Module:      proxy.js
 * Description: Reverse proxy manager (Nginx / Caddy), virtual hosts configuration, syntax testing, and logs.
 *
 * @author      Najmul Islam
 * @developer   Najmul Islam
 * @contact     f2pnajmul@gmail.com
 * @license     MIT License (see LICENSE file for details)
 * @copyright   (c) 2026 Najmul Islam. All rights reserved.
 * ============================================================================
 */

function _authProxyFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class ProxyManager {
    constructor() {
        this.engine = null;
        this.hosts = [];
        this.isLoading = false;
        this.initDOM();
    }

    initDOM() {
        // Engine status cards
        this.engineNameEl = document.getElementById('proxy-engine-name');
        this.engineStatusBadge = document.getElementById('proxy-engine-badge');
        this.hostsCountEl = document.getElementById('proxy-hosts-count');
        this.activeHostsEl = document.getElementById('proxy-active-hosts');

        // Actions
        this.testSyntaxBtn = document.getElementById('btn-proxy-test-syntax');
        this.reloadBtn = document.getElementById('btn-proxy-reload');
        this.createHostBtn = document.getElementById('btn-proxy-create-modal');
        this.refreshBtn = document.getElementById('btn-proxy-refresh');
        this.viewLogsBtn = document.getElementById('btn-proxy-view-logs');

        // Table
        this.tableBody = document.getElementById('proxy-hosts-table-body');
        this.tableEmpty = document.getElementById('proxy-table-empty');
        this.tableLoading = document.getElementById('proxy-table-loading');

        // Create Modal
        this.createModal = document.getElementById('modal-create-proxy-host');
        this.createForm = document.getElementById('form-create-proxy-host');
        this.domainInput = document.getElementById('proxy-host-domain');
        this.forwardHostInput = document.getElementById('proxy-host-forward-host');
        this.forwardPortInput = document.getElementById('proxy-host-forward-port');
        this.forwardSchemeSelect = document.getElementById('proxy-host-scheme');
        this.enableSslCheck = document.getElementById('proxy-host-ssl');
        this.enableWsCheck = document.getElementById('proxy-host-ws');
        this.maxBodyInput = document.getElementById('proxy-host-max-body');
        this.submitHostBtn = document.getElementById('btn-submit-create-proxy');

        // Raw Config Modal
        this.configModal = document.getElementById('modal-proxy-config');
        this.configTitle = document.getElementById('proxy-config-title');
        this.configBody = document.getElementById('proxy-config-body');

        // Logs Modal
        this.logsModal = document.getElementById('modal-proxy-logs');
        this.logsContainer = document.getElementById('proxy-logs-container');
        this.status2xxEl = document.getElementById('proxy-stat-2xx');
        this.status3xxEl = document.getElementById('proxy-stat-3xx');
        this.status4xxEl = document.getElementById('proxy-stat-4xx');
        this.status5xxEl = document.getElementById('proxy-stat-5xx');

        // Wire event listeners
        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => this.loadProxyData(true));
        }

        if (this.testSyntaxBtn) {
            this.testSyntaxBtn.addEventListener('click', () => this.testSyntax());
        }

        if (this.reloadBtn) {
            this.reloadBtn.addEventListener('click', () => this.reloadDaemon());
        }

        if (this.createHostBtn) {
            this.createHostBtn.addEventListener('click', () => this.openCreateModal());
        }

        if (this.createForm) {
            this.createForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitHost();
            });
        }

        if (this.viewLogsBtn) {
            this.viewLogsBtn.addEventListener('click', () => this.openLogsModal());
        }

        // Modal close listeners
        document.querySelectorAll('[data-close-modal="modal-create-proxy-host"]').forEach(b => {
            b.addEventListener('click', () => {
                if (this.createModal) this.createModal.style.display = 'none';
            });
        });

        document.querySelectorAll('[data-close-modal="modal-proxy-config"]').forEach(b => {
            b.addEventListener('click', () => {
                if (this.configModal) this.configModal.style.display = 'none';
            });
        });

        document.querySelectorAll('[data-close-modal="modal-proxy-logs"]').forEach(b => {
            b.addEventListener('click', () => {
                if (this.logsModal) this.logsModal.style.display = 'none';
            });
        });

        // Close on overlay click
        [this.createModal, this.configModal, this.logsModal].forEach(m => {
            if (m) {
                m.addEventListener('click', (e) => {
                    if (e.target === m) m.style.display = 'none';
                });
            }
        });
    }

    static init() {
        if (!window.proxyMgr) {
            window.proxyMgr = new ProxyManager();
        }
        window.proxyMgr.loadProxyData();
    }

    async loadProxyData(showToastFeedback = false) {
        if (this.isLoading) return;
        this.isLoading = true;

        if (this.tableLoading) this.tableLoading.style.display = 'block';
        if (this.tableEmpty) this.tableEmpty.style.display = 'none';

        try {
            const res = await _authProxyFetch('/api/proxy/hosts');
            if (res.ok) {
                const data = await res.json();
                this.engine = data.engine || {};
                this.hosts = data.hosts || [];
                this.renderStatus(data);
                this.renderHosts();
                if (showToastFeedback && window.showToast) {
                    window.showToast('Reverse proxy configuration refreshed.', 'success');
                }
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (e) {
            console.error('[ProxyManager] Load error:', e);
            if (window.showToast) window.showToast('Failed to load proxy hosts: ' + e.message, 'error');
        } finally {
            this.isLoading = false;
            if (this.tableLoading) this.tableLoading.style.display = 'none';
        }
    }

    renderStatus(data) {
        const eng = data.engine || {};
        if (this.engineNameEl) {
            this.engineNameEl.textContent = `${eng.engine ? eng.engine.toUpperCase() : 'Nginx'} ${eng.version || ''}`;
        }
        if (this.engineStatusBadge) {
            if (eng.is_active) {
                this.engineStatusBadge.textContent = '● ACTIVE';
                this.engineStatusBadge.className = 'badge badge-online';
            } else {
                this.engineStatusBadge.textContent = '● STOPPED';
                this.engineStatusBadge.className = 'badge badge-offline';
            }
        }
        if (this.hostsCountEl) this.hostsCountEl.textContent = data.total_hosts || '0';
        if (this.activeHostsEl) this.activeHostsEl.textContent = data.active_hosts || '0';
    }

    renderHosts() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';

        if (!this.hosts || this.hosts.length === 0) {
            if (this.tableEmpty) this.tableEmpty.style.display = 'block';
            return;
        }

        if (this.tableEmpty) this.tableEmpty.style.display = 'none';

        this.hosts.forEach((h, idx) => {
            const tr = document.createElement('tr');
            const portsBadge = (h.ports || [80]).map(p => `<span class="badge" style="background:rgba(255,255,255,0.06); font-family:var(--font-mono); font-size:0.75rem;">:${p}</span>`).join(' ');
            const sslBadge = h.has_ssl
                ? `<span class="badge" style="background:rgba(34,197,94,0.15); color:var(--accent-green);">🔒 SSL Active</span>`
                : `<span class="badge" style="background:rgba(255,255,255,0.05); color:var(--text-dim);">HTTP Only</span>`;
            const wsBadge = h.has_websocket
                ? `<span class="badge" style="background:rgba(168,85,247,0.15); color:var(--accent-purple);" title="WebSocket upgrade enabled">⚡ WS</span>`
                : '';

            const statusClass = h.is_enabled ? 'toggle-on' : 'toggle-off';
            const statusLabel = h.is_enabled ? 'Active' : 'Disabled';

            tr.innerHTML = `
                <td>
                    <div style="font-weight:600; font-family:var(--font-mono); font-size:0.88rem; color:var(--accent-cyan); display:flex; align-items:center; gap:0.4rem;">
                        <span>🌐 ${this._escapeHtml(h.primary_domain)}</span>
                        ${h.is_default ? '<span class="badge" style="background:rgba(245,158,11,0.15); color:var(--accent-amber); font-size:0.68rem;">DEFAULT</span>' : ''}
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-dim); margin-top:3px; font-family:var(--font-mono);">
                        ${this._escapeHtml(h.filename)}
                    </div>
                </td>
                <td>${portsBadge}</td>
                <td>
                    <span style="font-family:var(--font-mono); font-size:0.82rem; color:var(--text-main); background:rgba(0,0,0,0.25); padding:0.2rem 0.4rem; border-radius:4px;">
                        ${this._escapeHtml(h.upstream || 'Local Static Root')}
                    </span>
                    ${wsBadge}
                </td>
                <td>${sslBadge}</td>
                <td>
                    <button class="btn btn-sm ${h.is_enabled ? 'btn-secondary' : 'btn-secondary'}" onclick="window.proxyMgr.toggleHost('${h.filename}')" style="font-size:0.75rem; padding:0.25rem 0.55rem; color:${h.is_enabled ? 'var(--accent-green)' : 'var(--text-dim)'}; border-color:${h.is_enabled ? 'rgba(34,197,94,0.3)' : 'var(--border-color)'};">
                        ${h.is_enabled ? '● Active' : '○ Disabled'}
                    </button>
                </td>
                <td style="text-align:right; white-space:nowrap;">
                    <button class="btn btn-sm btn-secondary" onclick="window.proxyMgr.viewConfig(${idx})" title="View raw nginx config" style="font-size:0.75rem; padding:0.25rem 0.55rem;">
                        📄 View
                    </button>
                    <button class="btn btn-sm btn-danger admin-only" onclick="window.proxyMgr.deleteHost('${h.filename}')" title="Delete virtual host" style="font-size:0.75rem; padding:0.25rem 0.55rem;">
                        🗑️
                    </button>
                </td>
            `;
            this.tableBody.appendChild(tr);
        });
    }

    openCreateModal() {
        if (this.createModal) {
            this.createModal.style.display = 'flex';
            if (this.domainInput) this.domainInput.value = '';
            if (this.forwardHostInput) this.forwardHostInput.value = '127.0.0.1';
            if (this.forwardPortInput) this.forwardPortInput.value = '8000';
        }
    }

    async submitHost() {
        const domain = this.domainInput?.value?.trim() || '';
        const forwardHost = this.forwardHostInput?.value?.trim() || '127.0.0.1';
        const forwardPort = parseInt(this.forwardPortInput?.value || '80', 10);
        const forwardScheme = this.forwardSchemeSelect?.value || 'http';
        const enableSsl = Boolean(this.enableSslCheck?.checked);
        const enableWebsocket = Boolean(this.enableWsCheck?.checked);
        const maxBody = this.maxBodyInput?.value?.trim() || '128M';

        if (!domain) {
            if (window.showToast) window.showToast('Domain name is required.', 'warning');
            return;
        }

        if (this.submitHostBtn) {
            this.submitHostBtn.disabled = true;
            this.submitHostBtn.textContent = 'Validating & Applying...';
        }

        try {
            const res = await _authProxyFetch('/api/proxy/hosts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    domain,
                    forward_host: forwardHost,
                    forward_port: forwardPort,
                    forward_scheme: forwardScheme,
                    enable_ssl: enableSsl,
                    enable_websocket: enableWebsocket,
                    max_body_size: maxBody
                })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                if (this.createModal) this.createModal.style.display = 'none';
                if (window.showToast) {
                    window.showToast(`Reverse proxy host for '${domain}' created & activated!`, 'success');
                }
                await this.loadProxyData();
            } else {
                throw new Error(data.details || data.error || 'Failed to create host');
            }
        } catch (e) {
            console.error('[ProxyManager] Create error:', e);
            if (window.showToast) window.showToast('Configuration error: ' + e.message, 'error', 6000);
        } finally {
            if (this.submitHostBtn) {
                this.submitHostBtn.disabled = false;
                this.submitHostBtn.textContent = 'Create & Activate Route';
            }
        }
    }

    async toggleHost(filename) {
        if (!filename) return;
        try {
            const res = await _authProxyFetch('/api/proxy/hosts/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(data.message, 'success');
                await this.loadProxyData();
            } else {
                throw new Error(data.details || data.error || 'Toggle failed');
            }
        } catch (e) {
            if (window.showToast) window.showToast('Toggle error: ' + e.message, 'error', 6000);
        }
    }

    async deleteHost(filename) {
        if (!confirm(`Delete virtual host configuration '${filename}'? This will stop proxying traffic for this domain.`)) return;

        try {
            const res = await _authProxyFetch('/api/proxy/hosts', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(`Proxy host '${filename}' deleted.`, 'info');
                await this.loadProxyData();
            } else {
                throw new Error(data.error || 'Delete failed');
            }
        } catch (e) {
            if (window.showToast) window.showToast('Delete error: ' + e.message, 'error');
        }
    }

    async testSyntax() {
        if (window.showToast) window.showToast('Testing Nginx configuration syntax...', 'info');
        try {
            const res = await _authProxyFetch('/api/proxy/test', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(`✅ ${data.message || 'Syntax is OK!'}`, 'success', 5000);
            } else {
                const err = data.stderr || data.stdout || data.error;
                if (window.showToast) window.showToast(`❌ Syntax Error: ${err}`, 'error', 7000);
            }
        } catch (e) {
            if (window.showToast) window.showToast('Syntax test failed: ' + e.message, 'error');
        }
    }

    async reloadDaemon() {
        if (window.showToast) window.showToast('Reloading reverse proxy daemon...', 'info');
        try {
            const res = await _authProxyFetch('/api/proxy/reload', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast('✅ ' + data.message, 'success');
            } else {
                throw new Error(data.details || data.error || 'Reload failed');
            }
        } catch (e) {
            if (window.showToast) window.showToast('Reload error: ' + e.message, 'error', 6000);
        }
    }

    viewConfig(idx) {
        const host = this.hosts[idx];
        if (!host || !this.configModal) return;

        if (this.configTitle) this.configTitle.textContent = `Config: ${host.filename}`;
        if (this.configBody) {
            this.configBody.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                    <span style="font-size:0.8rem; color:var(--text-dim); font-family:var(--font-mono);">${this._escapeHtml(host.filepath)}</span>
                    <button class="btn btn-sm btn-secondary" onclick="window.copyToClipboard('${this._escapeHtml(host.raw_config).replace(/'/g, "\\'")}', 'Copied config to clipboard!');" style="font-size:0.75rem; padding:0.25rem 0.55rem;">📋 Copy</button>
                </div>
                <pre style="background:rgba(0,0,0,0.4); border:1px solid var(--border-color); border-radius:6px; padding:1rem; font-family:var(--font-mono); font-size:0.8rem; color:var(--text-main); overflow-x:auto; max-height:450px;">${this._escapeHtml(host.raw_config)}</pre>
            `;
        }
        this.configModal.style.display = 'flex';
    }

    async openLogsModal() {
        if (!this.logsModal) return;
        this.logsModal.style.display = 'flex';
        if (this.logsContainer) this.logsContainer.textContent = 'Loading logs...';

        try {
            const res = await _authProxyFetch('/api/proxy/logs?lines=60');
            const data = await res.json();
            if (res.ok && data.success) {
                const sc = data.status_counts || {};
                if (this.status2xxEl) this.status2xxEl.textContent = sc['2xx'] || '0';
                if (this.status3xxEl) this.status3xxEl.textContent = sc['3xx'] || '0';
                if (this.status4xxEl) this.status4xxEl.textContent = sc['4xx'] || '0';
                if (this.status5xxEl) this.status5xxEl.textContent = sc['5xx'] || '0';

                const logs = (data.access_logs || []).concat(data.error_logs ? data.error_logs.map(e => `[ERROR] ${e}`) : []);
                if (this.logsContainer) {
                    this.logsContainer.textContent = logs.length ? logs.join('\n') : 'No recent access or error logs found.';
                }
            }
        } catch (e) {
            if (this.logsContainer) this.logsContainer.textContent = 'Error loading logs: ' + e.message;
        }
    }

    _escapeHtml(str) {
        return (str || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

window.ProxyManager = ProxyManager;
