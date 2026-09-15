/**
 * fleet.js — PulseOps Enterprise Fleet Management UI
 *
 * Renders the fleet overview dashboard with server cards, live status,
 * search/filter, add server modal, agent install token generation, and
 * real-time status updates via WebSocket fleet events.
 */

const FleetManager = (() => {
    let _servers     = [];
    let _searchQuery = '';
    let _sortBy      = 'status';
    let _activeTag   = '';
    let _isLoaded    = false;

    // ── Status helpers ─────────────────────────────────────────────────────────

    const STATUS_CONFIG = {
        online:      { label: 'Online',      cls: 'status-online',      icon: '●', badge: '🟢' },
        degraded:    { label: 'Degraded',    cls: 'status-degraded',    icon: '●', badge: '🟡' },
        offline:     { label: 'Offline',     cls: 'status-offline',     icon: '●', badge: '🔴' },
        unreachable: { label: 'Unreachable', cls: 'status-unreachable', icon: '●', badge: '⚫' },
    };

    function getStatusConfig(status) {
        return STATUS_CONFIG[status] || STATUS_CONFIG.unreachable;
    }

    function formatUptime(seconds) {
        if (!seconds) return '--';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    function formatBytes(bytes) {
        if (!bytes) return '0 B/s';
        if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB/s';
        if (bytes > 1024)    return (bytes / 1024).toFixed(1) + ' KB/s';
        return bytes + ' B/s';
    }

    function getBarColor(pct) {
        if (pct >= 90) return 'var(--status-offline)';
        if (pct >= 75) return 'var(--accent-amber)';
        return 'var(--status-online)';
    }

    // ── Load Fleet Servers ────────────────────────────────────────────────────

    async function loadServers() {
        try {
            const query = _searchQuery ? `?q=${encodeURIComponent(_searchQuery)}` : '';
            const resp  = await PulseOpsAuth.apiFetch(`/api/fleet/servers${query}`);
            if (!resp || !resp.ok) return;
            _servers = await resp.json();
            _isLoaded = true;
            renderFleet();
            updateSummaryStats();
            if (window.PulseOpsApp && typeof window.PulseOpsApp.updateSidebarServers === 'function') {
                window.PulseOpsApp.updateSidebarServers(_servers);
            }
        } catch (e) {
            console.error('[Fleet] Load error:', e);
        }
    }

    // ── Render Fleet Grid ─────────────────────────────────────────────────────

    function renderFleet() {
        const container = document.getElementById('fleet-grid');
        if (!container) return;

        let filtered = _servers;
        if (_activeTag) {
            filtered = filtered.filter(s => (s.tags || []).includes(_activeTag));
        }

        // Sort
        filtered = [...filtered].sort((a, b) => {
            const order = { online: 0, degraded: 1, offline: 2, unreachable: 3 };
            if (_sortBy === 'status') return (order[a.status] ?? 9) - (order[b.status] ?? 9);
            if (_sortBy === 'cpu')    return (b.latest_cpu || 0) - (a.latest_cpu || 0);
            if (_sortBy === 'mem')    return (b.latest_mem || 0) - (a.latest_mem || 0);
            if (_sortBy === 'name')   return (a.hostname || '').localeCompare(b.hostname || '');
            return 0;
        });

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="fleet-empty">
                    <div style="font-size:3rem; margin-bottom:1rem;">🖥️</div>
                    <h3 style="color:var(--text-muted); margin-bottom:0.5rem;">No servers found</h3>
                    <p style="color:var(--text-dim); font-size:0.9rem; margin-bottom:1.25rem;">
                        ${_searchQuery ? 'Try a different search query.' : 'Add your first server to get started with fleet monitoring.'}
                    </p>
                    ${(!_searchQuery && window.PulseOpsAuth && window.PulseOpsAuth.isAdmin()) ? `
                    <button class="btn-primary admin-only" onclick="window.openAddServerModal && window.openAddServerModal()">+ Add Server</button>
                    ` : ''}
                </div>`;
            return;
        }

        container.innerHTML = filtered.map(srv => buildServerCard(srv)).join('');
        attachCardListeners();
    }

    function buildServerCard(srv) {
        const sc     = getStatusConfig(srv.status);
        const cpu    = srv.latest_cpu != null ? srv.latest_cpu.toFixed(1) : '--';
        const mem    = srv.latest_mem != null ? srv.latest_mem.toFixed(1) : '--';
        const disk   = srv.latest_disk != null ? srv.latest_disk.toFixed(1) : '--';
        const uptime = formatUptime(srv.latest_uptime);
        const lastSeen = srv.last_seen ? new Date(srv.last_seen).toLocaleString() : 'Never';
        const tags   = (srv.tags || []).map(t => `<span class="server-tag">${t}</span>`).join('');
        const isMain = srv.host_ip === window.location.hostname || srv.host_ip === '127.0.0.1';
        const inMaintenance = srv.maintenance_until && new Date(srv.maintenance_until) > new Date();

        const cpuWidth  = srv.latest_cpu  != null ? srv.latest_cpu.toFixed(0) : 0;
        const memWidth  = srv.latest_mem  != null ? srv.latest_mem.toFixed(0) : 0;
        const diskWidth = srv.latest_disk != null ? srv.latest_disk.toFixed(0) : 0;

        const driver = (srv.driver_type || 'agent').toLowerCase();
        let driverBadge = '';
        if (driver === 'snmp') {
            driverBadge = '<span class="driver-badge driver-snmp" style="background:rgba(245,158,11,0.15); color:#fbbf24; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(245,158,11,0.3);" title="SNMP Polled Device">📡 SNMP</span>';
        } else if (driver === 'ssh') {
            driverBadge = '<span class="driver-badge driver-ssh" style="background:rgba(168,85,247,0.15); color:#c084fc; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(168,85,247,0.3);" title="Agentless SSH Node">🔑 SSH</span>';
        } else if (driver === 'probe') {
            driverBadge = '<span class="driver-badge driver-probe" style="background:rgba(16,185,129,0.15); color:#34d399; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(16,185,129,0.3);" title="Network TCP Probe">🌐 PROBE</span>';
        } else if (driver === 'prometheus') {
            driverBadge = '<span class="driver-badge driver-prom" style="background:rgba(239,68,68,0.15); color:#f87171; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(239,68,68,0.3);" title="Prometheus Node Exporter">📊 EXPORTER</span>';
        } else {
            driverBadge = '<span class="driver-badge driver-agent" style="background:rgba(59,130,246,0.15); color:#60a5fa; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(59,130,246,0.3);" title="PulseOps Native Agent">⚡ AGENT</span>';
        }

        return `
        <div class="server-card ${sc.cls}" data-server-id="${srv.id}" data-hostname="${srv.hostname}" tabindex="0">
            <div class="server-card-header">
                <div class="server-status-row">
                    <span class="server-status-dot ${sc.cls}"></span>
                    <span class="server-status-label">${sc.label}</span>
                    ${driverBadge}
                    ${inMaintenance ? '<span class="maintenance-badge" title="In Maintenance">🔧 Maintenance</span>' : ''}
                    ${isMain ? '<span class="main-badge">MASTER</span>' : ''}
                </div>
                ${(window.PulseOpsAuth && window.PulseOpsAuth.isAdmin()) ? `
                <div class="server-card-actions admin-only">
                    <button class="server-action-btn" data-action="edit" data-server-id="${srv.id}" title="Edit server">✏️</button>
                    ${!isMain ? `<button class="server-action-btn danger" data-action="delete" data-server-id="${srv.id}" data-hostname="${srv.display_name || srv.hostname}" title="Remove server">🗑️</button>` : ''}
                </div>` : ''}
            </div>

            <div class="server-hostname">${srv.display_name || srv.hostname}</div>
            <div class="server-ip">${srv.host_ip}:${srv.agent_port}</div>
            ${srv.os_info ? `<div class="server-os">${srv.os_info.length > 35 ? srv.os_info.substring(0,35)+'...' : srv.os_info}</div>` : ''}

            ${driver === 'probe' ? `
            <div class="server-metrics" style="padding:0.6rem 0.2rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.2); border-radius:6px; padding:0.4rem 0.75rem;">
                    <span style="font-size:0.75rem; color:var(--text-muted);">Round-Trip Latency:</span>
                    <span style="font-family:var(--font-mono); font-size:0.85rem; font-weight:700; color:var(--accent-green);">${srv.latest_load != null ? srv.latest_load + ' ms' : '--'}</span>
                </div>
            </div>` : `
            <div class="server-metrics">
                <div class="server-metric-row">
                    <span class="server-metric-label">CPU</span>
                    <div class="server-metric-bar-bg">
                        <div class="server-metric-bar-fill" style="width:${cpuWidth}%; background:${getBarColor(cpuWidth)};"></div>
                    </div>
                    <span class="server-metric-val">${cpu}%</span>
                </div>
                <div class="server-metric-row">
                    <span class="server-metric-label">RAM</span>
                    <div class="server-metric-bar-bg">
                        <div class="server-metric-bar-fill" style="width:${memWidth}%; background:${getBarColor(memWidth)};"></div>
                    </div>
                    <span class="server-metric-val">${mem}%</span>
                </div>
                <div class="server-metric-row">
                    <span class="server-metric-label">DISK</span>
                    <div class="server-metric-bar-bg">
                        <div class="server-metric-bar-fill" style="width:${diskWidth}%; background:${getBarColor(diskWidth)};"></div>
                    </div>
                    <span class="server-metric-val">${disk}%</span>
                </div>
            </div>`}

            <div class="server-meta">
                <span title="Uptime">↑ ${uptime}</span>
                <span title="Last seen" style="color:var(--text-dim); font-size:0.72rem;">
                    ${srv.status === 'online' ? '● Live' : 'Last: ' + (srv.last_seen ? new Date(srv.last_seen).toLocaleTimeString() : 'Never')}
                </span>
            </div>

            ${tags ? `<div class="server-tags">${tags}</div>` : ''}
        </div>`;
    }

    function attachCardListeners() {
        document.querySelectorAll('.server-card').forEach(card => {
            // Card click → open server dashboard
            card.addEventListener('click', (e) => {
                if (e.target.closest('.server-action-btn') || e.target.closest('.server-card-actions')) return;
                const serverId = card.dataset.serverId;
                openServerDashboard(serverId, card.dataset.hostname);
            });

            // Action buttons
            card.querySelectorAll('.server-action-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    const action = btn.dataset.action;
                    const serverId = btn.dataset.serverId;
                    if (action === 'delete') {
                        confirmDeleteServer(serverId, btn.dataset.hostname);
                    } else if (action === 'edit') {
                        openEditServerModal(serverId);
                    }
                });
            });
        });
    }

    // ── Summary Stats ─────────────────────────────────────────────────────────

    function updateSummaryStats() {
        const counts = { online: 0, degraded: 0, offline: 0, unreachable: 0 };
        _servers.forEach(s => { counts[s.status] = (counts[s.status] || 0) + 1; });

        const total = _servers.length;
        setText('fleet-stat-total',      total);
        setText('fleet-stat-online',     counts.online);
        setText('fleet-stat-degraded',   counts.degraded);
        setText('fleet-stat-offline',    counts.offline + counts.unreachable);
        setText('fleet-count-total',     total);
        setText('fleet-count-online',    counts.online);
        setText('fleet-count-degraded',  counts.degraded);
        setText('fleet-count-offline',   counts.offline + counts.unreachable);
    }

    function setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    // ── Fleet Update via WebSocket ─────────────────────────────────────────────

    function handleFleetUpdate(payload) {
        const idx = _servers.findIndex(s => s.id === payload.server_id);
        if (idx !== -1) {
            _servers[idx].status     = payload.status;
            if (payload.snapshot) {
                _servers[idx].latest_cpu  = payload.snapshot.cpu_percent;
                _servers[idx].latest_mem  = payload.snapshot.mem_percent;
                _servers[idx].latest_disk = payload.snapshot.disk_percent;
                _servers[idx].latest_uptime = payload.snapshot.uptime;
            }
            // Re-render only the affected card for efficiency
            const card = document.querySelector(`.server-card[data-server-id="${payload.server_id}"]`);
            if (card) {
                const newCard = document.createElement('div');
                newCard.innerHTML = buildServerCard(_servers[idx]);
                const newEl = newCard.firstElementChild;
                card.replaceWith(newEl);
                newEl.addEventListener('click', (e) => {
                    if (!e.target.closest('.server-action-btn')) {
                        openServerDashboard(newEl.dataset.serverId, newEl.dataset.hostname);
                    }
                });
            }
            updateSummaryStats();
            if (window.PulseOpsApp && typeof window.PulseOpsApp.updateSidebarServers === 'function') {
                window.PulseOpsApp.updateSidebarServers(_servers);
            }
        }
    }

    // ── Open Server Dashboard ─────────────────────────────────────────────────

    function openServerDashboard(serverId, hostname) {
        // Store current server context for proxy calls
        window.PulseOpsCurrentServer = serverId;
        window.PulseOpsCurrentServerHostname = hostname;
        // Switch to dashboard view
        showSection('server-dashboard');
        updateBreadcrumb([
            { label: 'Fleet', action: () => showSection('fleet') },
            { label: hostname || serverId },
        ]);
        // Trigger per-server dashboard load
        document.dispatchEvent(new CustomEvent('pulseops:server:selected', {
            detail: { serverId, hostname }
        }));
    }

    // ── Modals ────────────────────────────────────────────────────────────────

    let _activeDriverTab = 'agent';
    let _activeAgentSubtab = 'auto';

    function openAddServerModal() {
        const modal = document.getElementById('add-server-modal');
        if (modal) {
            modal.classList.add('active');
            modal.style.display = 'flex';
            
            // Clear test connection box
            const testBox = document.getElementById('add-server-test-box');
            if (testBox) { testBox.style.display = 'none'; testBox.innerHTML = ''; }
            
            // Default to Agent tab and Auto subtab
            switchDriverTab('agent');
            switchAgentSubtab('auto');
        }
    }

    function switchDriverTab(driverId) {
        _activeDriverTab = driverId;
        
        // Update tab buttons
        document.querySelectorAll('#add-server-modal .modal-tab').forEach(btn => {
            if (btn.dataset.driverTab === driverId) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Show matching pane
        document.querySelectorAll('#add-server-modal .driver-pane').forEach(pane => {
            pane.style.display = 'none';
        });
        const targetPane = document.getElementById(`driver-pane-${driverId}`);
        if (targetPane) targetPane.style.display = 'block';

        // Clear test feedback
        const testBox = document.getElementById('add-server-test-box');
        if (testBox) { testBox.style.display = 'none'; testBox.innerHTML = ''; }

        // Update footer buttons visibility / text based on tab
        const testBtn = document.getElementById('add-server-test-btn');
        const submitBtn = document.getElementById('add-server-submit-btn');

        if (driverId === 'agent' && _activeAgentSubtab === 'auto') {
            if (testBtn) testBtn.style.display = 'none';
            if (submitBtn) { submitBtn.textContent = 'Close'; submitBtn.dataset.mode = 'close'; }
        } else {
            if (testBtn) testBtn.style.display = 'flex';
            if (submitBtn) { submitBtn.textContent = 'Add to Fleet'; submitBtn.dataset.mode = 'add'; }
        }
    }

    function switchAgentSubtab(subtab) {
        _activeAgentSubtab = subtab;
        const autoSubtabBtn = document.getElementById('agent-subtab-auto');
        const manualSubtabBtn = document.getElementById('agent-subtab-manual');
        const autoPane = document.getElementById('agent-subpane-auto');
        const manualPane = document.getElementById('agent-subpane-manual');

        if (subtab === 'auto') {
            if (autoSubtabBtn) {
                autoSubtabBtn.classList.add('active');
                autoSubtabBtn.style.background = 'rgba(56,189,248,0.15)';
                autoSubtabBtn.style.color = 'var(--accent-cyan)';
            }
            if (manualSubtabBtn) {
                manualSubtabBtn.classList.remove('active');
                manualSubtabBtn.style.background = 'transparent';
                manualSubtabBtn.style.color = 'var(--text-dim)';
            }
            if (autoPane) autoPane.style.display = 'block';
            if (manualPane) manualPane.style.display = 'none';
        } else {
            if (manualSubtabBtn) {
                manualSubtabBtn.classList.add('active');
                manualSubtabBtn.style.background = 'rgba(56,189,248,0.15)';
                manualSubtabBtn.style.color = 'var(--accent-cyan)';
            }
            if (autoSubtabBtn) {
                autoSubtabBtn.classList.remove('active');
                autoSubtabBtn.style.background = 'transparent';
                autoSubtabBtn.style.color = 'var(--text-dim)';
            }
            if (autoPane) autoPane.style.display = 'none';
            if (manualPane) manualPane.style.display = 'block';
        }

        const testBtn = document.getElementById('add-server-test-btn');
        const submitBtn = document.getElementById('add-server-submit-btn');
        if (subtab === 'auto') {
            if (testBtn) testBtn.style.display = 'none';
            if (submitBtn) { submitBtn.textContent = 'Close'; submitBtn.dataset.mode = 'close'; }
        } else {
            if (testBtn) testBtn.style.display = 'flex';
            if (submitBtn) { submitBtn.textContent = 'Add to Fleet'; submitBtn.dataset.mode = 'add'; }
        }
    }

    function getActiveDriverPayload() {
        const driver = _activeDriverTab || 'agent';
        let payload = {
            driver_type: driver === 'prom' ? 'prometheus' : driver,
            hostname: '',
            host_ip: '',
            display_name: '',
            agent_port: 0,
            tags: [],
            notes: '',
            driver_config: {}
        };

        if (driver === 'agent') {
            payload.hostname = (document.getElementById('agent-hostname')?.value || '').trim();
            payload.host_ip = (document.getElementById('agent-ip')?.value || '').trim();
            payload.display_name = (document.getElementById('agent-displayname')?.value || '').trim() || payload.hostname;
            payload.agent_port = parseInt(document.getElementById('agent-port')?.value) || 3500;
            payload.tags = (document.getElementById('agent-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
            payload.notes = (document.getElementById('agent-notes')?.value || '').trim();
            const token = (document.getElementById('agent-token-auth')?.value || '').trim();
            if (token) payload.driver_config.agent_token = token;
        } else if (driver === 'snmp') {
            payload.hostname = (document.getElementById('snmp-hostname')?.value || '').trim();
            payload.host_ip = (document.getElementById('snmp-ip')?.value || '').trim();
            payload.display_name = (document.getElementById('snmp-displayname')?.value || '').trim() || payload.hostname;
            payload.agent_port = parseInt(document.getElementById('snmp-port')?.value) || 161;
            payload.tags = (document.getElementById('snmp-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
            payload.notes = (document.getElementById('snmp-notes')?.value || '').trim();
            payload.driver_config = {
                version: parseInt(document.getElementById('snmp-version')?.value) || 2,
                community: (document.getElementById('snmp-community')?.value || 'public').trim(),
                location: (document.getElementById('snmp-location')?.value || '').trim()
            };
        } else if (driver === 'ssh') {
            payload.hostname = (document.getElementById('ssh-hostname')?.value || '').trim();
            payload.host_ip = (document.getElementById('ssh-ip')?.value || '').trim();
            payload.display_name = (document.getElementById('ssh-displayname')?.value || '').trim() || payload.hostname;
            payload.agent_port = parseInt(document.getElementById('ssh-port')?.value) || 22;
            payload.tags = (document.getElementById('ssh-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
            payload.notes = (document.getElementById('ssh-notes')?.value || '').trim();
            const authMethod = document.getElementById('ssh-auth-method')?.value || 'password';
            payload.driver_config = {
                username: (document.getElementById('ssh-username')?.value || 'root').trim(),
                auth_method: authMethod,
                password: (document.getElementById('ssh-password')?.value || ''),
                private_key: (document.getElementById('ssh-private-key')?.value || ''),
                passphrase: (document.getElementById('ssh-passphrase')?.value || '')
            };
        } else if (driver === 'probe') {
            payload.hostname = (document.getElementById('probe-hostname')?.value || '').trim();
            payload.host_ip = (document.getElementById('probe-ip')?.value || '').trim();
            payload.display_name = (document.getElementById('probe-displayname')?.value || '').trim() || payload.hostname;
            payload.agent_port = parseInt(document.getElementById('probe-port')?.value) || 443;
            payload.tags = (document.getElementById('probe-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
            payload.notes = (document.getElementById('probe-notes')?.value || '').trim();
            payload.driver_config = { probe_type: 'tcp' };
        } else if (driver === 'prom') {
            payload.driver_type = 'prometheus';
            payload.hostname = (document.getElementById('prom-hostname')?.value || '').trim();
            payload.host_ip = (document.getElementById('prom-ip')?.value || '').trim();
            payload.display_name = (document.getElementById('prom-displayname')?.value || '').trim() || payload.hostname;
            payload.agent_port = parseInt(document.getElementById('prom-port')?.value) || 9100;
            payload.tags = (document.getElementById('prom-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
            payload.notes = (document.getElementById('prom-notes')?.value || '').trim();
            payload.driver_config = {
                path: (document.getElementById('prom-path')?.value || '/metrics').trim(),
                tls: !!document.getElementById('prom-tls')?.checked
            };
        }

        return payload;
    }

    async function testCurrentConnection() {
        const payload = getActiveDriverPayload();
        const testBtn = document.getElementById('add-server-test-btn');
        const testBox = document.getElementById('add-server-test-box');

        if (!payload.host_ip) {
            showToast('Host IP or target address is required to test', 'warning');
            if (testBox) {
                testBox.style.display = 'block';
                testBox.style.background = 'rgba(239,68,68,0.1)';
                testBox.style.border = '1px solid rgba(239,68,68,0.3)';
                testBox.style.color = '#fca5a5';
                testBox.innerHTML = '⚠️ Please enter a valid Host IP or hostname first.';
            }
            return;
        }

        if (testBtn) {
            testBtn.disabled = true;
            testBtn.innerHTML = '<span>⏳ Testing...</span>';
        }
        if (testBox) {
            testBox.style.display = 'block';
            testBox.style.background = 'rgba(56,189,248,0.08)';
            testBox.style.border = '1px solid rgba(56,189,248,0.25)';
            testBox.style.color = 'var(--accent-cyan)';
            testBox.innerHTML = `<span>Connecting to <strong>${payload.host_ip}:${payload.agent_port}</strong> via ${payload.driver_type.toUpperCase()}...</span>`;
        }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/fleet/test-connection', {
                method: 'POST',
                body: JSON.stringify({
                    driver_type: payload.driver_type,
                    host_ip: payload.host_ip,
                    port: payload.agent_port,
                    driver_config: payload.driver_config
                })
            });
            const data = await resp.json();

            if (resp.ok && data.success) {
                let detailItems = '';
                if (data.details) {
                    detailItems = Object.entries(data.details)
                        .filter(([k, v]) => v != null && v !== '')
                        .map(([k, v]) => `<span style="display:inline-block; margin-right:8px; padding:2px 6px; background:rgba(255,255,255,0.06); border-radius:4px; font-size:0.75rem;">${k}: <strong>${v}</strong></span>`)
                        .join('');
                }

                testBox.style.background = 'rgba(34,197,94,0.12)';
                testBox.style.border = '1px solid rgba(34,197,94,0.35)';
                testBox.style.color = '#86efac';
                testBox.innerHTML = `
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
                        <span style="font-weight:700;">✅ ${data.message || 'Connection Successful!'}</span>
                        <span style="font-family:var(--font-mono); font-size:0.75rem; background:rgba(34,197,94,0.2); padding:2px 6px; border-radius:4px; color:#22c55e;">⚡ ${data.latency_ms || 0} ms</span>
                    </div>
                    ${detailItems ? `<div style="margin-top:6px; font-family:var(--font-mono);">${detailItems}</div>` : ''}
                `;
                showToast(`Connected successfully in ${data.latency_ms}ms`, 'success');
            } else {
                testBox.style.background = 'rgba(239,68,68,0.12)';
                testBox.style.border = '1px solid rgba(239,68,68,0.35)';
                testBox.style.color = '#fca5a5';
                testBox.innerHTML = `
                    <div style="display:flex; align-items:center; justify-content:space-between;">
                        <span style="font-weight:700;">❌ Connection Failed</span>
                        ${data.latency_ms ? `<span style="font-family:var(--font-mono); font-size:0.75rem; color:#ef4444;">${data.latency_ms} ms</span>` : ''}
                    </div>
                    <div style="margin-top:4px; font-size:0.78rem; word-break:break-all;">${data.error || data.detail || 'Target did not respond'}</div>
                `;
                showToast(data.error || data.detail || 'Test connection failed', 'error');
            }
        } catch (err) {
            testBox.style.background = 'rgba(239,68,68,0.12)';
            testBox.style.border = '1px solid rgba(239,68,68,0.35)';
            testBox.style.color = '#fca5a5';
            testBox.innerHTML = `<strong>❌ Network error:</strong> ${err.message || 'Failed to reach backend test service'}`;
            showToast('Network error during test', 'error');
        } finally {
            if (testBtn) {
                testBtn.disabled = false;
                testBtn.innerHTML = '<span>🧪 Test Connection</span>';
            }
        }
    }

    function openEditServerModal(serverId) {
        const srv = _servers.find(s => s.id === serverId);
        if (!srv) return;
        // Populate edit form
        const modal = document.getElementById('edit-server-modal');
        if (!modal) return;
        document.getElementById('edit-server-id').value       = serverId;
        document.getElementById('edit-server-displayname').value = srv.display_name || '';
        document.getElementById('edit-server-tags').value     = (srv.tags || []).join(', ');
        document.getElementById('edit-server-notes').value    = srv.notes || '';
        document.getElementById('edit-server-port').value     = srv.agent_port || 3500;
        const driver = (srv.driver_type || 'agent').toLowerCase();
        const driverEl = document.getElementById('edit-server-driver');
        if (driverEl) {
            driverEl.textContent = driver === 'snmp' ? '📡 SNMP DEVICE' :
                                  driver === 'ssh' ? '🔑 AGENTLESS SSH' :
                                  driver === 'probe' ? '🌐 TCP PROBE' :
                                  driver === 'prometheus' ? '📊 NODE EXPORTER' : '⚡ NATIVE AGENT';
        }
        modal.classList.add('active');
        modal.style.display = 'flex';
    }

    async function confirmDeleteServer(serverId, hostname) {
        if (window.PulseOpsAuth && !window.PulseOpsAuth.isAdmin()) {
            showToast('Permission denied: Only Administrators can remove servers', 'error');
            return;
        }
        if (!confirm(`Remove server "${hostname}" from the fleet?\n\nThis will remove the server and its history from the dashboard.`)) return;
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/fleet/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE' });
            if (resp && resp.ok) {
                _servers = _servers.filter(s => s.id !== serverId);
                renderFleet();
                updateSummaryStats();

                if (window.PulseOpsApp) {
                    if (window.PulseOpsApp.currentServerId === serverId) {
                        window.PulseOpsApp.currentServerId = 'local-master';
                        window.PulseOpsCurrentServer = 'local-master';
                        showSection('fleet');
                    }
                    if (typeof window.PulseOpsApp.updateSidebarServers === 'function') {
                        window.PulseOpsApp.updateSidebarServers(_servers);
                    }
                }

                showToast(`Server "${hostname}" removed successfully`, 'success');
            } else {
                const data = resp ? await resp.json().catch(() => ({})) : {};
                showToast(data.detail || data.error || 'Failed to remove server', 'error');
            }
        } catch (e) {
            showToast('Error removing server', 'error');
        }
    }

    async function submitAddServer() {
        const submitBtn = document.getElementById('add-server-submit-btn');
        if (submitBtn && submitBtn.dataset.mode === 'close') {
            const m = document.getElementById('add-server-modal');
            if (m) { m.classList.remove('active'); m.style.display = 'none'; }
            return;
        }

        const payload = getActiveDriverPayload();

        if (!payload.hostname || !payload.host_ip) {
            showToast('Hostname and Host IP are required', 'error');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Adding to Fleet...';

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/fleet/servers', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Server "${payload.hostname}" (${payload.driver_type}) added to fleet!`, 'success');
                const m = document.getElementById('add-server-modal');
                if (m) { m.classList.remove('active'); m.style.display = 'none'; }
                loadServers();
            } else {
                showToast(data.detail || data.error || 'Failed to add server', 'error');
            }
        } catch (e) {
            showToast('Network error', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Add to Fleet';
            }
        }
    }

    // ── Agent Install Token Generation ────────────────────────────────────────

    async function generateInviteToken() {
        const btn = document.getElementById('generate-token-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/fleet/invite-tokens', {
                method: 'POST',
                body: JSON.stringify({ expires_hours: 24 }),
            });
            const data = await resp.json();
            const token = data.token;

            // Build the curl command
            const masterUrl = window.location.origin;
            const curlCmd = `curl -sSL "${masterUrl}/api/fleet/agent-install.sh?token=${token}" | sudo bash`;

            document.getElementById('agent-curl-cmd').textContent = curlCmd;
            document.getElementById('agent-token-display').style.display = 'block';
            document.getElementById('agent-token-expires').textContent =
                new Date(data.expires_at).toLocaleString();

            // Start expiry countdown
            startTokenCountdown(new Date(data.expires_at));
        } catch (e) {
            showToast('Failed to generate token', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🔑 Generate Install Token'; }
        }
    }

    function startTokenCountdown(expiry) {
        const el = document.getElementById('agent-token-countdown');
        if (!el) return;
        function tick() {
            const diff = expiry - Date.now();
            if (diff <= 0) { el.textContent = 'Expired'; return; }
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            el.textContent = `${h}h ${m}m ${s}s remaining`;
            setTimeout(tick, 1000);
        }
        tick();
    }

    // ── Tag Filters ───────────────────────────────────────────────────────────

    function buildTagFilters() {
        const allTags = new Set();
        _servers.forEach(s => (s.tags || []).forEach(t => allTags.add(t)));

        const container = document.getElementById('fleet-tag-filters');
        if (!container) return;

        const btns = [{ label: 'All', value: '' }, ...[...allTags].sort().map(t => ({ label: t, value: t }))];
        container.innerHTML = btns.map(b =>
            `<button class="btn-tag-filter ${_activeTag === b.value ? 'active' : ''}" data-tag="${b.value}">${b.label}</button>`
        ).join('');

        container.querySelectorAll('.btn-tag-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                _activeTag = btn.dataset.tag;
                container.querySelectorAll('.btn-tag-filter').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderFleet();
            });
        });
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        // Search
        const searchInput = document.getElementById('fleet-search-input');
        if (searchInput) {
            let debounce;
            searchInput.addEventListener('input', () => {
                clearTimeout(debounce);
                _searchQuery = searchInput.value;
                debounce = setTimeout(() => loadServers(), 300);
            });
        }

        // Sort
        const sortSelect = document.getElementById('fleet-sort-select');
        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                _sortBy = sortSelect.value;
                renderFleet();
            });
        }

        // Add server button
        const addBtn = document.getElementById('fleet-add-server-btn');
        if (addBtn) addBtn.addEventListener('click', openAddServerModal);

        // Add server form submit
        const addForm = document.getElementById('add-server-form');
        if (addForm) addForm.addEventListener('submit', (e) => { e.preventDefault(); submitAddServer(); });

        const addSubmitBtn = document.getElementById('add-server-submit-btn');
        if (addSubmitBtn) addSubmitBtn.addEventListener('click', submitAddServer);

        // Modal close buttons
        document.querySelectorAll('[data-close-modal]').forEach(btn => {
            btn.addEventListener('click', () => {
                const modalId = btn.dataset.closeModal;
                const modal = document.getElementById(modalId);
                if (modal) {
                    modal.classList.remove('active');
                    modal.style.display = 'none';
                }
            });
        });

        // Agent install token
        const genBtn = document.getElementById('generate-token-btn');
        if (genBtn) genBtn.addEventListener('click', generateInviteToken);

        // Copy curl command
        const copyBtn = document.getElementById('copy-curl-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const cmdEl = document.getElementById('agent-curl-cmd');
                const cmd = cmdEl ? cmdEl.textContent.trim() : '';
                if (cmd) {
                    window.copyToClipboard(cmd, 'Copied install command to clipboard!');
                    const origText = copyBtn.innerHTML;
                    copyBtn.innerHTML = '✅ Copied!';
                    setTimeout(() => { copyBtn.innerHTML = origText; }, 2000);
                }
            });
        }

        // Also enable direct click-to-copy on the command pre container
        const cmdEl = document.getElementById('agent-curl-cmd');
        if (cmdEl) {
            cmdEl.style.cursor = 'pointer';
            cmdEl.title = 'Click to copy command';
            cmdEl.addEventListener('click', () => {
                const cmd = cmdEl.textContent.trim();
                if (cmd) {
                    window.copyToClipboard(cmd, 'Copied install command to clipboard!');
                    if (copyBtn) {
                        const origText = copyBtn.innerHTML;
                        copyBtn.innerHTML = '✅ Copied!';
                        setTimeout(() => { copyBtn.innerHTML = origText; }, 2000);
                    }
                }
            });
        }

        // Add server driver tabs
        document.querySelectorAll('#add-server-modal [data-driver-tab]').forEach(tabBtn => {
            tabBtn.addEventListener('click', () => {
                switchDriverTab(tabBtn.dataset.driverTab);
            });
        });

        // Agent subtabs (Auto Install vs Manual)
        const autoSubtabBtn = document.getElementById('agent-subtab-auto');
        const manualSubtabBtn = document.getElementById('agent-subtab-manual');
        if (autoSubtabBtn) autoSubtabBtn.addEventListener('click', () => switchAgentSubtab('auto'));
        if (manualSubtabBtn) manualSubtabBtn.addEventListener('click', () => switchAgentSubtab('manual'));

        // SSH Auth method dropdown toggle
        const sshAuthMethodSelect = document.getElementById('ssh-auth-method');
        if (sshAuthMethodSelect) {
            sshAuthMethodSelect.addEventListener('change', () => {
                const isKey = sshAuthMethodSelect.value === 'key';
                const passGroup = document.getElementById('ssh-auth-password-group');
                const keyGroup = document.getElementById('ssh-auth-key-group');
                if (passGroup) passGroup.style.display = isKey ? 'none' : 'block';
                if (keyGroup) keyGroup.style.display = isKey ? 'block' : 'none';
            });
        }

        // Test Connection button
        const testBtn = document.getElementById('add-server-test-btn');
        if (testBtn) testBtn.addEventListener('click', testCurrentConnection);

        // Edit server save
        const editSaveBtn = document.getElementById('edit-server-save-btn');
        if (editSaveBtn) editSaveBtn.addEventListener('click', submitEditServer);

        // Initial load
        loadServers().then(() => buildTagFilters());

        // Auto-refresh every 30 seconds
        setInterval(loadServers, 30000);
    }

    async function submitEditServer() {
        const serverId   = document.getElementById('edit-server-id').value;
        const display_name = document.getElementById('edit-server-displayname').value.trim();
        const tags_raw   = document.getElementById('edit-server-tags').value.trim();
        const notes      = document.getElementById('edit-server-notes').value.trim();
        const agent_port = parseInt(document.getElementById('edit-server-port').value) || 3500;
        const tags = tags_raw ? tags_raw.split(',').map(t => t.trim()).filter(Boolean) : [];

        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/fleet/servers/${serverId}`, {
                method: 'PUT',
                body: JSON.stringify({ display_name, tags, notes, agent_port }),
            });
            if (resp && resp.ok) {
                showToast('Server updated', 'success');
                const m = document.getElementById('edit-server-modal');
                if (m) { m.classList.remove('active'); m.style.display = 'none'; }
                loadServers();
            } else {
                showToast('Failed to update server', 'error');
            }
        } catch { showToast('Network error', 'error'); }
    }

    // Public API
    const api = {
        init,
        loadServers,
        handleFleetUpdate,
        renderFleet,
        openAddServerModal,
        openServerDashboard,
        confirmDeleteServer,
        getServers: () => _servers,
    };
    window.PulseOpsFleet = api;
    window.openAddServerModal = openAddServerModal;
    window.openServerDashboard = openServerDashboard;
    window.confirmDeleteFleetServer = confirmDeleteServer;
    return api;
})();
