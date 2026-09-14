/* ==========================================================================
   PulseOps - Enterprise SSL / TLS Certificate Lifecycle & Domain Health
   Provides host certificate discovery, live TLS handshake probe,
   monitored endpoints watchlist, and x509 certificate inspection.
   ========================================================================== */

function _authSslFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class SSLManager {
    constructor() {
        this.localCerts = [];
        this.monitoredDomains = [];
        this.lastProbeResult = null;
        this.isLoading = false;

        this.initDOM();
    }

    initDOM() {
        // Stat counters
        this.statTotal = document.getElementById('ssl-stat-total');
        this.statTotalSub = document.getElementById('ssl-stat-total-sub');
        this.statValid = document.getElementById('ssl-stat-valid');
        this.statWarning = document.getElementById('ssl-stat-warning');
        this.statCritical = document.getElementById('ssl-stat-critical');

        // Live Probe Form
        this.probeForm = document.getElementById('form-ssl-probe');
        this.probeHostInput = document.getElementById('ssl-probe-host');
        this.probePortInput = document.getElementById('ssl-probe-port');
        this.probeSubmitBtn = document.getElementById('btn-ssl-probe-submit');
        this.probeResultEl = document.getElementById('ssl-probe-result');
        this.refreshBtn = document.getElementById('btn-ssl-refresh');

        // Monitored Domains
        this.monitoredTableBody = document.getElementById('ssl-monitored-table-body');
        this.addDomainBtn = document.getElementById('btn-ssl-add-domain');

        // Local Host Certs
        this.localTableBody = document.getElementById('ssl-local-table-body');
        this.localCountBadge = document.getElementById('ssl-local-count-badge');

        // Modals
        this.detailsModal = document.getElementById('modal-ssl-details');
        this.modalTitle = document.getElementById('ssl-modal-title');
        this.modalSubtitle = document.getElementById('ssl-modal-subtitle');
        this.modalBody = document.getElementById('ssl-modal-body');

        this.addModal = document.getElementById('modal-ssl-add-domain');
        this.addForm = document.getElementById('form-ssl-add-domain');
        this.addHostInput = document.getElementById('ssl-add-host');
        this.addPortInput = document.getElementById('ssl-add-port');
        this.addLabelInput = document.getElementById('ssl-add-label');
        this.addSubmitBtn = document.getElementById('btn-submit-ssl-add');

        // Wire Event Listeners
        if (this.probeForm) {
            this.probeForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.probeEndpoint();
            });
        }

        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => {
                this.loadSSLData(true);
            });
        }

        if (this.addDomainBtn) {
            this.addDomainBtn.addEventListener('click', () => {
                this.openAddModal();
            });
        }

        if (this.addForm) {
            this.addForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitAddDomain();
            });
        }
    }

    _escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    _getCurrentServerId() {
        if (window.PulseOpsApp && window.PulseOpsApp.currentServerId) {
            return window.PulseOpsApp.currentServerId;
        }
        return 'local-master';
    }

    // ── Main Data Loader ──────────────────────────────────────────────────
    async loadSSLData(showFeedback = false) {
        if (this.isLoading) return;
        this.isLoading = true;

        const serverId = this._getCurrentServerId();
        const hostname = window.PulseOpsCurrentServerHostname || 'Current Server';

        if (showFeedback && window.showToast) {
            window.showToast(`Refreshing SSL & TLS status on ${hostname}...`, 'info', 2000);
        }

        try {
            const [certsRes, monRes] = await Promise.all([
                _authSslFetch(`/api/ssl/certificates?server_id=${encodeURIComponent(serverId)}`),
                _authSslFetch('/api/ssl/monitored')
            ]);

            if (certsRes.ok) {
                const certsData = await certsRes.json();
                this.localCerts = certsData.certificates || [];
            } else {
                this.localCerts = [];
            }

            if (monRes.ok) {
                const monData = await monRes.json();
                this.monitoredDomains = monData.domains || [];
            } else {
                this.monitoredDomains = [];
            }

            this.updateStats();
            this.renderLocalCerts();
            this.renderMonitoredDomains();

            if (showFeedback && window.showToast) {
                window.showToast(`SSL discovery updated: ${this.localCerts.length} host certs, ${this.monitoredDomains.length} monitored`, 'success', 2500);
            }
        } catch (err) {
            console.error('Failed to load SSL data:', err);
            if (showFeedback && window.showToast) {
                window.showToast('Failed to load SSL certificates', 'error');
            }
        } finally {
            this.isLoading = false;
        }
    }

    // ── Stat Counters ─────────────────────────────────────────────────────
    updateStats() {
        const totalTracked = this.localCerts.length + this.monitoredDomains.length;
        let validCount = 0;
        let warningCount = 0;
        let criticalCount = 0;

        const countItem = (item) => {
            const days = item.days_remaining;
            if (days === null || days === undefined) {
                if (item.status === 'valid') validCount++;
                else if (item.status === 'warning') warningCount++;
                else criticalCount++;
                return;
            }
            if (days <= 0 || item.is_expired || item.status === 'expired' || item.status === 'critical') {
                criticalCount++;
            } else if (days <= 30 || item.status === 'warning') {
                warningCount++;
            } else {
                validCount++;
            }
        };

        this.localCerts.forEach(countItem);
        this.monitoredDomains.forEach(countItem);

        if (this.statTotal) this.statTotal.textContent = totalTracked;
        if (this.statValid) this.statValid.textContent = validCount;
        if (this.statWarning) this.statWarning.textContent = warningCount;
        if (this.statCritical) this.statCritical.textContent = criticalCount;
        if (this.statTotalSub) {
            this.statTotalSub.textContent = `${this.localCerts.length} Local • ${this.monitoredDomains.length} Monitored`;
        }
        if (this.localCountBadge) {
            this.localCountBadge.textContent = `${this.localCerts.length} Certificates`;
        }
    }

    // ── Render Local Certificates ─────────────────────────────────────────
    renderLocalCerts() {
        if (!this.localTableBody) return;

        if (!this.localCerts || this.localCerts.length === 0) {
            this.localTableBody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align:center; color:var(--text-dim); padding:2rem;">
                        No SSL certificates found in standard system paths (/etc/ssl, /etc/pki, /etc/letsencrypt, /etc/nginx).
                    </td>
                </tr>`;
            return;
        }

        const rowsHtml = this.localCerts.map((cert, idx) => {
            const days = cert.days_remaining;
            let statusBadge = '';
            let barColor = '#22c55e';
            let barPct = 100;

            if (cert.is_expired || (days !== null && days <= 0)) {
                statusBadge = '<span class="ssl-badge ssl-badge-critical">🔴 Expired</span>';
                barColor = '#ef4444';
                barPct = 0;
            } else if (days !== null && days <= 7) {
                statusBadge = '<span class="ssl-badge ssl-badge-critical">🔴 Critical</span>';
                barColor = '#ef4444';
                barPct = Math.max(5, Math.min(100, Math.round((days / 90) * 100)));
            } else if (days !== null && days <= 30) {
                statusBadge = '<span class="ssl-badge ssl-badge-warning">🟡 Warning</span>';
                barColor = '#f59e0b';
                barPct = Math.max(10, Math.min(100, Math.round((days / 90) * 100)));
            } else {
                statusBadge = '<span class="ssl-badge ssl-badge-valid">🟢 Valid</span>';
                barColor = '#22c55e';
                barPct = Math.max(20, Math.min(100, Math.round(((days || 90) / 90) * 100)));
            }

            if (cert.is_self_signed) {
                statusBadge += ' <span class="ssl-badge ssl-badge-self" title="Self-Signed Certificate">Self-Signed</span>';
            }

            const daysText = days !== null && days !== undefined
                ? (days > 0 ? `${days} days` : `Expired ${Math.abs(days)}d ago`)
                : 'Unknown';

            return `
                <tr>
                    <td>
                        <div style="font-family:var(--font-mono); font-size:0.82rem; font-weight:600; color:var(--accent-cyan);">${this._escapeHtml(cert.file_name)}</div>
                        <div style="font-family:var(--font-mono); font-size:0.72rem; color:var(--text-dim); max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${this._escapeHtml(cert.file_path)}">${this._escapeHtml(cert.file_path)}</div>
                    </td>
                    <td>
                        <div style="font-family:var(--font-mono); font-size:0.84rem; font-weight:600; color:var(--text-main);">${this._escapeHtml(cert.subject_cn || cert.file_name)}</div>
                        ${cert.sans && cert.sans.length > 0 ? `<div style="font-size:0.72rem; color:var(--text-dim);">${cert.sans.length} SANs</div>` : ''}
                    </td>
                    <td style="font-size:0.8rem; color:var(--text-muted); max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${this._escapeHtml(cert.issuer)}">
                        ${this._escapeHtml(cert.issuer || 'Unknown')}
                    </td>
                    <td style="font-size:0.8rem; color:var(--text-dim); white-space:nowrap;">
                        ${cert.not_after ? this._escapeHtml(cert.not_after.split(' ')[0]) : '--'}
                    </td>
                    <td>
                        <div class="ssl-days-bar-container">
                            <span style="font-family:var(--font-mono); font-size:0.78rem; font-weight:600; min-width:60px;">${daysText}</span>
                            <div class="ssl-days-bar-track">
                                <div class="ssl-days-bar-fill" style="width:${barPct}%; background:${barColor};"></div>
                            </div>
                        </div>
                    </td>
                    <td>${statusBadge}</td>
                    <td style="text-align:right;">
                        <button class="btn btn-sm btn-secondary" onclick="window.sslMgr && window.sslMgr.openLocalCertModal(${idx})" title="Inspect full x509 certificate details" style="padding:0.25rem 0.6rem; font-size:0.75rem;">
                            🔍 Details
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        this.localTableBody.innerHTML = rowsHtml;
    }

    // ── Render Monitored Domains Watchlist ─────────────────────────────────
    renderMonitoredDomains() {
        if (!this.monitoredTableBody) return;

        if (!this.monitoredDomains || this.monitoredDomains.length === 0) {
            this.monitoredTableBody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align:center; color:var(--text-dim); padding:2rem;">
                        No monitored endpoints yet. Use the Live TLS Probe box above or click <strong>+ Add Endpoint</strong>.
                    </td>
                </tr>`;
            return;
        }

        const rowsHtml = this.monitoredDomains.map((dom) => {
            const days = dom.days_remaining;
            let statusBadge = '';
            let barColor = '#22c55e';
            let barPct = 100;

            if (dom.last_status === 'error') {
                statusBadge = '<span class="ssl-badge ssl-badge-critical">🔴 Connection Failed</span>';
                barColor = '#ef4444';
                barPct = 0;
            } else if (dom.last_status === 'expired' || (days !== null && days <= 0)) {
                statusBadge = '<span class="ssl-badge ssl-badge-critical">🔴 Expired</span>';
                barColor = '#ef4444';
                barPct = 0;
            } else if (dom.last_status === 'critical' || (days !== null && days <= 7)) {
                statusBadge = '<span class="ssl-badge ssl-badge-critical">🔴 Critical</span>';
                barColor = '#ef4444';
                barPct = Math.max(5, Math.min(100, Math.round((days / 90) * 100)));
            } else if (dom.last_status === 'warning' || (days !== null && days <= 30)) {
                statusBadge = '<span class="ssl-badge ssl-badge-warning">🟡 Warning</span>';
                barColor = '#f59e0b';
                barPct = Math.max(10, Math.min(100, Math.round((days / 90) * 100)));
            } else if (dom.last_status === 'valid') {
                statusBadge = '<span class="ssl-badge ssl-badge-valid">🟢 Valid</span>';
                barColor = '#22c55e';
                barPct = Math.max(20, Math.min(100, Math.round(((days || 90) / 90) * 100)));
            } else {
                statusBadge = `<span class="ssl-badge ssl-badge-unknown">${this._escapeHtml(dom.last_status || 'Unknown')}</span>`;
                barColor = '#64748b';
                barPct = 50;
            }

            const daysText = days !== null && days !== undefined
                ? (days > 0 ? `${days} days` : `Expired ${Math.abs(days)}d ago`)
                : '--';

            const cipherPill = dom.cipher
                ? `<span class="ssl-cipher-pill" title="${this._escapeHtml(dom.cipher)}">${this._escapeHtml(dom.tls_version || 'TLS')} • ${this._escapeHtml(dom.cipher)}</span>`
                : `<span style="font-size:0.75rem; color:var(--text-dim);">${this._escapeHtml(dom.tls_version || '--')}</span>`;

            return `
                <tr>
                    <td>
                        <div style="font-family:var(--font-mono); font-size:0.86rem; font-weight:600; color:var(--text-main);">${this._escapeHtml(dom.host)}</div>
                        ${dom.label && dom.label !== dom.host ? `<div style="font-size:0.75rem; color:var(--text-muted);">${this._escapeHtml(dom.label)}</div>` : ''}
                    </td>
                    <td style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-dim);">${dom.port || 443}</td>
                    <td>
                        ${cipherPill}
                        ${dom.latency_ms ? `<div class="ssl-latency-tag">⚡ ${dom.latency_ms} ms</div>` : ''}
                    </td>
                    <td style="font-size:0.8rem; color:var(--text-muted); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${this._escapeHtml(dom.issuer)}">
                        ${this._escapeHtml(dom.issuer || '--')}
                    </td>
                    <td>
                        <div class="ssl-days-bar-container">
                            <span style="font-family:var(--font-mono); font-size:0.78rem; font-weight:600; min-width:60px;">${daysText}</span>
                            <div class="ssl-days-bar-track">
                                <div class="ssl-days-bar-fill" style="width:${barPct}%; background:${barColor};"></div>
                            </div>
                        </div>
                    </td>
                    <td>${statusBadge}</td>
                    <td style="text-align:right;">
                        <div style="display:inline-flex; gap:0.4rem; align-items:center;">
                            <button class="btn btn-sm btn-secondary" onclick="window.sslMgr && window.sslMgr.refreshDomain(${dom.id})" title="Re-probe endpoint now" style="padding:0.25rem 0.5rem; font-size:0.75rem;">
                                🔄
                            </button>
                            <button class="btn btn-sm btn-secondary" onclick="window.sslMgr && window.sslMgr.inspectMonitored(${dom.id})" title="View Certificate Details" style="padding:0.25rem 0.55rem; font-size:0.75rem;">
                                🔍
                            </button>
                            <button class="btn btn-sm btn-danger-action operator-only" onclick="window.sslMgr && window.sslMgr.deleteDomain(${dom.id}, '${this._escapeHtml(dom.host)}')" title="Remove from watchlist" style="padding:0.25rem 0.5rem; font-size:0.75rem;">
                                🗑️
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        this.monitoredTableBody.innerHTML = rowsHtml;
    }

    // ── Live TLS Probe ────────────────────────────────────────────────────
    async probeEndpoint() {
        if (!this.probeHostInput) return;
        const host = this.probeHostInput.value.trim();
        const port = parseInt(this.probePortInput.value, 10) || 443;

        if (!host) {
            if (window.showToast) window.showToast('Please enter a hostname or IP to probe', 'error');
            return;
        }

        const serverId = this._getCurrentServerId();

        // UI Loading state
        this.probeSubmitBtn.disabled = true;
        this.probeSubmitBtn.innerHTML = '<span>⏳</span> Probing TLS...';
        this.probeResultEl.style.display = 'block';
        this.probeResultEl.innerHTML = `
            <div style="display:flex; align-items:center; gap:0.75rem; color:var(--text-muted); font-size:0.85rem; padding:0.5rem 0;">
                <div class="spinner" style="width:18px; height:18px; border:2px solid rgba(0,242,254,0.3); border-top-color:var(--accent-cyan); border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                <span>Establishing TCP connection and performing TLS handshake with <strong>${this._escapeHtml(host)}:${port}</strong>...</span>
            </div>
        `;

        try {
            const res = await _authSslFetch('/api/ssl/probe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, server_id: serverId })
            });

            const data = await res.json();
            this.lastProbeResult = data;
            this.renderProbeResult(data, host, port);
        } catch (err) {
            console.error('Probe error:', err);
            this.probeResultEl.innerHTML = `
                <div style="color:var(--accent-red); font-size:0.85rem; display:flex; align-items:center; gap:0.5rem;">
                    <span>⚠️</span> Handshake failed: Could not connect or initiate TLS with ${this._escapeHtml(host)}:${port}. ${this._escapeHtml(err.message)}
                </div>
            `;
        } finally {
            this.probeSubmitBtn.disabled = false;
            this.probeSubmitBtn.innerHTML = '<span>🔍</span> Test Handshake';
        }
    }

    renderProbeResult(data, host, port) {
        if (!this.probeResultEl) return;

        if (!data.success) {
            this.probeResultEl.innerHTML = `
                <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
                    <div style="color:var(--accent-red); font-weight:600; font-size:0.9rem; display:flex; align-items:center; gap:0.5rem;">
                        <span>❌</span> TLS Handshake Failed for ${this._escapeHtml(host)}:${port}
                    </div>
                    <span class="ssl-badge ssl-badge-critical">Connection Error</span>
                </div>
                <div style="margin-top:0.5rem; font-family:var(--font-mono); font-size:0.8rem; color:var(--text-dim); background:rgba(0,0,0,0.3); padding:0.6rem 0.8rem; border-radius:4px; border-left:3px solid var(--accent-red);">
                    ${this._escapeHtml(data.error || 'Connection timed out or certificate verification rejected.')}
                </div>
            `;
            return;
        }

        const days = data.days_remaining;
        let badgeHtml = '';
        if (data.is_expired || (days !== null && days <= 0)) {
            badgeHtml = '<span class="ssl-badge ssl-badge-critical">🔴 Expired</span>';
        } else if (days !== null && days <= 7) {
            badgeHtml = '<span class="ssl-badge ssl-badge-critical">🔴 Critical (&le; 7 Days)</span>';
        } else if (days !== null && days <= 30) {
            badgeHtml = '<span class="ssl-badge ssl-badge-warning">🟡 Warning (&le; 30 Days)</span>';
        } else {
            badgeHtml = '<span class="ssl-badge ssl-badge-valid">🟢 Secure &amp; Valid</span>';
        }

        if (data.trusted === false) {
            badgeHtml += ' <span class="ssl-badge ssl-badge-self" title="Self-Signed or Untrusted Root CA">Untrusted / Self-Signed</span>';
        }

        const sansList = (data.sans && data.sans.length > 0)
            ? data.sans.map(s => `<span class="ssl-san-chip">${this._escapeHtml(s)}</span>`).join('')
            : '<span style="color:var(--text-dim); font-size:0.75rem;">None</span>';

        this.probeResultEl.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:0.75rem;">
                <div style="display:flex; align-items:center; gap:0.6rem;">
                    <span style="font-size:1.2rem;">🔒</span>
                    <div>
                        <div style="font-weight:700; font-size:0.95rem; color:var(--text-main); font-family:var(--font-mono);">${this._escapeHtml(host)}:${port}</div>
                        <div style="font-size:0.75rem; color:var(--text-dim);">Resolved Common Name: <strong>${this._escapeHtml(data.subject_cn || host)}</strong></div>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:0.5rem;">
                    ${badgeHtml}
                    <button class="btn btn-sm btn-primary operator-only" onclick="window.sslMgr && window.sslMgr.openAddModal('${this._escapeHtml(host)}', ${port}, '${this._escapeHtml(data.subject_cn || host)}')" style="font-size:0.75rem; padding:0.25rem 0.65rem;">
                        + Add to Watchlist
                    </button>
                </div>
            </div>

            <div class="ssl-probe-grid">
                <div class="ssl-probe-metric">
                    <div class="ssl-probe-metric-label">TLS Protocol &amp; Cipher</div>
                    <div class="ssl-probe-metric-val" style="font-size:0.85rem; font-family:var(--font-mono); color:var(--accent-cyan);">
                        ${this._escapeHtml(data.tls_version || 'TLS')} • ${this._escapeHtml(data.cipher || 'Standard')}
                    </div>
                    <div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">Cipher Key Bits: ${data.cipher_bits || 256} bit</div>
                </div>

                <div class="ssl-probe-metric">
                    <div class="ssl-probe-metric-label">Handshake Latency</div>
                    <div class="ssl-probe-metric-val" style="color:var(--accent-green);">
                        ⚡ ${data.latency_ms || '--'} ms
                    </div>
                    <div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">Socket connect + TLS negotiation</div>
                </div>

                <div class="ssl-probe-metric">
                    <div class="ssl-probe-metric-label">Issuer Authority</div>
                    <div class="ssl-probe-metric-val" style="font-size:0.85rem;" title="${this._escapeHtml(data.issuer)}">
                        ${this._escapeHtml(data.issuer || 'Unknown')}
                    </div>
                    <div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">Root / Intermediate CA</div>
                </div>

                <div class="ssl-probe-metric">
                    <div class="ssl-probe-metric-label">Certificate Validity</div>
                    <div class="ssl-probe-metric-val" style="font-size:0.85rem; color:${(days <= 7 ? 'var(--accent-red)' : (days <= 30 ? '#f59e0b' : 'var(--text-main)'))}">
                        ${days !== null ? `${days} Days Remaining` : '--'}
                    </div>
                    <div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">Expires: ${data.not_after || '--'}</div>
                </div>
            </div>

            <div style="margin-top:0.85rem; padding-top:0.75rem; border-top:1px dashed rgba(255,255,255,0.06);">
                <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-dim); margin-bottom:0.4rem;">
                    Subject Alternative Names (SANs - ${data.sans ? data.sans.length : 0})
                </div>
                <div style="max-height:85px; overflow-y:auto;">
                    ${sansList}
                </div>
            </div>
        `;
    }

    // ── Watchlist Management ──────────────────────────────────────────────
    openAddModal(prefillHost = '', prefillPort = 443, prefillLabel = '') {
        if (!this.addModal) return;
        if (this.addHostInput) this.addHostInput.value = prefillHost;
        if (this.addPortInput) this.addPortInput.value = prefillPort;
        if (this.addLabelInput) this.addLabelInput.value = prefillLabel;
        this.addModal.style.display = 'flex';
        if (!prefillHost && this.addHostInput) {
            setTimeout(() => this.addHostInput.focus(), 60);
        }
    }

    closeAddModal() {
        if (this.addModal) this.addModal.style.display = 'none';
    }

    async submitAddDomain() {
        const host = this.addHostInput.value.trim();
        const port = parseInt(this.addPortInput.value, 10) || 443;
        const label = this.addLabelInput.value.trim();

        if (!host) {
            if (window.showToast) window.showToast('Domain / Host is required', 'error');
            return;
        }

        const serverId = this._getCurrentServerId();
        this.addSubmitBtn.disabled = true;
        this.addSubmitBtn.textContent = 'Saving & Probing...';

        try {
            const res = await _authSslFetch('/api/ssl/monitored', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, label, server_id: serverId })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(`Endpoint ${host}:${port} added to monitored watchlist`, 'success', 3000);
                this.closeAddModal();
                await this.loadSSLData(false);
            } else {
                if (window.showToast) window.showToast(data.detail || data.error || 'Failed to add monitored domain', 'error');
            }
        } catch (err) {
            console.error('Failed to add monitored endpoint:', err);
            if (window.showToast) window.showToast('Network error adding monitored domain', 'error');
        } finally {
            this.addSubmitBtn.disabled = false;
            this.addSubmitBtn.textContent = 'Save & Probe';
        }
    }

    async refreshDomain(domainId) {
        if (window.showToast) window.showToast('Re-probing monitored endpoint...', 'info', 1500);

        try {
            const res = await _authSslFetch(`/api/ssl/monitored/${domainId}/refresh`, {
                method: 'POST'
            });

            const data = await res.json();
            if (res.ok && data.success) {
                const p = data.probe || {};
                const days = p.days_remaining !== undefined ? `${p.days_remaining} days left` : 'probed';
                if (window.showToast) window.showToast(`Endpoint re-probed: ${days}`, 'success', 2500);
                await this.loadSSLData(false);
            } else {
                if (window.showToast) window.showToast(data.error || 'Failed to re-probe endpoint', 'error');
            }
        } catch (err) {
            console.error('Refresh error:', err);
            if (window.showToast) window.showToast('Network error re-probing domain', 'error');
        }
    }

    async deleteDomain(domainId, host) {
        if (!confirm(`Are you sure you want to remove "${host}" from the monitored SSL watchlist?`)) {
            return;
        }

        try {
            const res = await _authSslFetch(`/api/ssl/monitored/${domainId}`, {
                method: 'DELETE'
            });

            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(`Removed "${host}" from watchlist`, 'success', 2500);
                await this.loadSSLData(false);
            } else {
                if (window.showToast) window.showToast(data.detail || data.error || 'Failed to delete monitored domain', 'error');
            }
        } catch (err) {
            console.error('Delete error:', err);
            if (window.showToast) window.showToast('Network error removing domain', 'error');
        }
    }

    // ── Inspection Modal ──────────────────────────────────────────────────
    openLocalCertModal(index) {
        const cert = this.localCerts[index];
        if (!cert) return;
        this.renderCertModal(cert, 'local');
    }

    inspectMonitored(domainId) {
        const dom = this.monitoredDomains.find(d => d.id === domainId);
        if (!dom) return;
        this.renderCertModal(dom, 'monitored');
    }

    renderCertModal(data, source = 'local') {
        if (!this.detailsModal || !this.modalBody) return;

        const isLocal = source === 'local';
        const title = isLocal ? `File: ${data.file_name}` : `Endpoint: ${data.host}:${data.port || 443}`;
        const subtitle = isLocal ? data.file_path : `Monitored Domain (${data.tls_version || 'TLS'} / ${data.cipher || 'Standard'})`;

        this.modalTitle.textContent = `🔒 ${title}`;
        this.modalSubtitle.textContent = subtitle;

        const days = data.days_remaining;
        let badgeHtml = '';
        if (data.is_expired || (days !== null && days <= 0)) {
            badgeHtml = '<span class="ssl-badge ssl-badge-critical">🔴 Expired</span>';
        } else if (days !== null && days <= 7) {
            badgeHtml = '<span class="ssl-badge ssl-badge-critical">🔴 Critical</span>';
        } else if (days !== null && days <= 30) {
            badgeHtml = '<span class="ssl-badge ssl-badge-warning">🟡 Warning</span>';
        } else {
            badgeHtml = '<span class="ssl-badge ssl-badge-valid">🟢 Valid</span>';
        }

        if (data.is_self_signed) {
            badgeHtml += ' <span class="ssl-badge ssl-badge-self">Self-Signed</span>';
        }

        const sansList = (data.sans && data.sans.length > 0)
            ? data.sans.map(s => `<span class="ssl-san-chip">${this._escapeHtml(s)}</span>`).join('')
            : '<span style="color:var(--text-dim); font-size:0.75rem;">None listed</span>';

        this.modalBody.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; padding-bottom:0.75rem; border-bottom:1px solid var(--border-color);">
                <div>
                    <div style="font-size:0.75rem; color:var(--text-dim); text-transform:uppercase;">Primary Common Name (CN)</div>
                    <div style="font-size:1.1rem; font-weight:700; color:var(--accent-cyan); font-family:var(--font-mono);">${this._escapeHtml(data.subject_cn || data.host || '--')}</div>
                </div>
                <div>${badgeHtml}</div>
            </div>

            <div class="inspect-grid" style="margin-bottom:1rem;">
                <div class="inspect-section">
                    <div class="inspect-section-title">Validity &amp; Expiry</div>
                    <div class="inspect-kv-list">
                        <div class="inspect-kv">
                            <span class="k">Days Remaining:</span>
                            <span class="v" style="font-weight:700; color:${days <= 7 ? 'var(--accent-red)' : (days <= 30 ? '#f59e0b' : 'var(--accent-green)')}">
                                ${days !== null && days !== undefined ? `${days} days` : '--'}
                            </span>
                        </div>
                        <div class="inspect-kv">
                            <span class="k">Valid From:</span>
                            <span class="v" style="font-family:var(--font-mono); font-size:0.78rem;">${this._escapeHtml(data.not_before || '--')}</span>
                        </div>
                        <div class="inspect-kv">
                            <span class="k">Expires On:</span>
                            <span class="v" style="font-family:var(--font-mono); font-size:0.78rem;">${this._escapeHtml(data.not_after || '--')}</span>
                        </div>
                    </div>
                </div>

                <div class="inspect-section">
                    <div class="inspect-section-title">Issuer Authority</div>
                    <div class="inspect-kv-list">
                        <div class="inspect-kv">
                            <span class="k">Issuer Organization:</span>
                            <span class="v" style="font-weight:600;">${this._escapeHtml(data.issuer || 'Unknown')}</span>
                        </div>
                        <div class="inspect-kv">
                            <span class="k">Self-Signed:</span>
                            <span class="v">${data.is_self_signed ? 'Yes' : 'No (CA Verified)'}</span>
                        </div>
                        <div class="inspect-kv">
                            <span class="k">Serial Number:</span>
                            <span class="v" style="font-family:var(--font-mono); font-size:0.75rem;">${this._escapeHtml(data.serial || '--')}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="inspect-section" style="margin-bottom:1rem;">
                <div class="inspect-section-title">Subject Alternative Names (SANs)</div>
                <div style="max-height:120px; overflow-y:auto; padding-top:0.25rem;">
                    ${sansList}
                </div>
            </div>

            ${data.fingerprint ? `
            <div class="inspect-section" style="margin-bottom:1rem;">
                <div class="inspect-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                    <span>SHA-256 Fingerprint</span>
                    <button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText('${this._escapeHtml(data.fingerprint)}'); window.showToast && window.showToast('Copied fingerprint to clipboard!', 'success');" style="font-size:0.7rem; padding:0.15rem 0.5rem;">📋 Copy</button>
                </div>
                <div style="font-family:var(--font-mono); font-size:0.75rem; color:var(--accent-cyan); word-break:break-all; background:rgba(0,0,0,0.3); padding:0.5rem 0.75rem; border-radius:4px; border:1px solid var(--border-color);">
                    ${this._escapeHtml(data.fingerprint)}
                </div>
            </div>
            ` : ''}

            ${data.file_path ? `
            <div class="inspect-section">
                <div class="inspect-section-title">File System Location</div>
                <div style="font-family:var(--font-mono); font-size:0.78rem; color:var(--text-muted); word-break:break-all;">
                    ${this._escapeHtml(data.file_path)}
                </div>
            </div>
            ` : ''}
        `;

        this.detailsModal.style.display = 'flex';
    }
}

// Global initialization
document.addEventListener('DOMContentLoaded', () => {
    window.sslMgr = new SSLManager();
});
