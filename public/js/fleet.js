/**
 * fleet.js — PulseOps Enterprise Fleet Management UI
 *
 * Renders the fleet overview dashboard with server cards, live status,
 * search/filter, add server modal, agent install token generation, and
 * real-time status updates via WebSocket fleet events.
 */

const FleetManager = (() => {
    let _servers      = [];
    let _searchQuery  = '';
    let _sortBy       = 'status';
    let _activeTag    = '';
    let _statusFilter = 'all';
    let _viewMode     = localStorage.getItem('pulseops-fleet-view') || 'grid';
    let _isLoaded     = false;

    // ── Distro OS Logos (SVG) ──────────────────────────────────────────────────

    function getDistroIcon(osInfo, size = 22) {
        const os = (osInfo || '').toLowerCase();
        if (os.includes('ubuntu')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#E95420"/>
                <circle cx="12" cy="5.2" r="1.6" fill="#fff"/>
                <circle cx="6.1" cy="15.4" r="1.6" fill="#fff"/>
                <circle cx="17.9" cy="15.4" r="1.6" fill="#fff"/>
                <path d="M12 7.6a4.4 4.4 0 0 1 3.8 2.2" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>
                <path d="M7.4 14.5a4.4 4.4 0 0 1 0-5" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>
                <path d="M12 16.4a4.4 4.4 0 0 1-3.8-2.2" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>
            </svg>`;
        }
        if (os.includes('debian')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#A80030"/>
                <path d="M12 6c-3.3 0-6 2.7-6 6 0 2.2 1.2 4.1 3 5.1-.3-.6-.5-1.3-.5-2.1 0-2.2 1.8-4 4-4s4 1.8 4 4c0 1.1-.4 2.1-1.2 2.8.8-.4 1.5-1 2-1.8.8-1.2 1.2-2.6 1.2-4 0-3.3-2.9-6-6.5-6z" fill="#fff"/>
            </svg>`;
        }
        if (os.includes('fedora')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#294172"/>
                <path d="M14.5 7.5a3 3 0 0 0-3 3v2h-2v2h2v4h2.5v-4h2v-2h-2v-2a1 1 0 0 1 1-1h1v-2h-1.5z" fill="#fff"/>
            </svg>`;
        }
        if (os.includes('arch')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#1793D1"/>
                <path d="M12 5.5l5.5 11.5-2.2-1.5-3.3-4.5-3.3 4.5-2.2 1.5L12 5.5z" fill="#fff"/>
            </svg>`;
        }
        if (os.includes('centos')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#262523"/>
                <path d="M12 6v6h-6v-6z" fill="#932279"/>
                <path d="M18 6v6h-6v-6z" fill="#ECA72C"/>
                <path d="M6 12v6h6v-6z" fill="#2285C5"/>
                <path d="M12 12v6h6v-6z" fill="#78B936"/>
            </svg>`;
        }
        if (os.includes('alpine')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#0D597F"/>
                <path d="M7 16l4-7 4 7H7zm6-4l2.5-4.5 3.5 6.5h-3.5L13 12z" fill="#fff"/>
            </svg>`;
        }
        if (os.includes('red hat') || os.includes('rhel')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#EE0000"/>
                <path d="M6 14.5c1-1 3-1.5 6-1.5s5 .5 6 1.5c-1 1-3 1.5-6 1.5s-5-.5-6-1.5z" fill="#111"/>
                <path d="M8 13.5c.5-3 2-5 4-5s3.5 2 4 5c-1-.5-2.5-.7-4-.7s-3 .2-4 .7z" fill="#fff"/>
            </svg>`;
        }
        if (os.includes('windows')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="2" width="20" height="20" rx="4" fill="#0078D4"/>
                <path d="M5 6.2l5.7-.8v5.6H5V6.2zm0 6.6h5.7v5.6L5 17.6v-4.8zm6.7-7.6l7.3-1v6.6h-7.3V5.2zm0 7.6h7.3v6.6l-7.3-1v-5.6z" fill="#fff"/>
            </svg>`;
        }
        if (os.includes('darwin') || os.includes('mac') || os.includes('apple')) {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#333"/>
                <path d="M14.8 12.3c0-1.8 1.4-2.6 1.5-2.7-0.8-1.2-2.1-1.4-2.5-1.4-1.1-.1-2.1.6-2.7.6-.5 0-1.4-.6-2.3-.6-1.2 0-2.3.7-2.9 1.8-1.3 2.1-.3 5.3 0.9 7.1.6.9 1.3 1.8 2.3 1.8.9 0 1.3-.6 2.4-.6s1.4.6 2.4.6c1 0 1.6-.8 2.2-1.7.7-1 1-2 1-2.1-.1 0-1.9-.7-1.9-2.8z" fill="#fff"/>
                <path d="M13.6 7.4c.5-.6.8-1.5.7-2.4-.8 0-1.6.5-2.1 1.1-.4.5-.8 1.4-.7 2.3.9.1 1.7-.4 2.1-1z" fill="#fff"/>
            </svg>`;
        }
        // Default Linux Tux Penguin
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" fill="#2d3748"/>
            <ellipse cx="12" cy="12.5" rx="4.5" ry="6" fill="#fff"/>
            <circle cx="12" cy="8" r="3.5" fill="#2d3748"/>
            <circle cx="10.8" cy="7.8" r="0.6" fill="#fff"/>
            <circle cx="13.2" cy="7.8" r="0.6" fill="#fff"/>
            <polygon points="12,9 10.5,10.2 13.5,10.2" fill="#F59E0B"/>
            <ellipse cx="9" cy="18" rx="2" ry="1" fill="#F59E0B"/>
            <ellipse cx="15" cy="18" rx="2" ry="1" fill="#F59E0B"/>
        </svg>`;
    }

    // ── Driver Badge Helper ────────────────────────────────────────────────────

    function getDriverBadge(driver) {
        driver = (driver || 'agent').toLowerCase();
        if (driver === 'snmp') {
            return '<span class="driver-badge driver-snmp" style="background:rgba(245,158,11,0.15); color:#fbbf24; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(245,158,11,0.3);" title="SNMP Polled Device">📡 SNMP</span>';
        } else if (driver === 'ssh') {
            return '<span class="driver-badge driver-ssh" style="background:rgba(168,85,247,0.15); color:#c084fc; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(168,85,247,0.3);" title="Agentless SSH Node">🔑 SSH</span>';
        } else if (driver === 'probe') {
            return '<span class="driver-badge driver-probe" style="background:rgba(16,185,129,0.15); color:#34d399; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(16,185,129,0.3);" title="Network TCP Probe">🌐 PROBE</span>';
        } else if (driver === 'prometheus') {
            return '<span class="driver-badge driver-prom" style="background:rgba(239,68,68,0.15); color:#f87171; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(239,68,68,0.3);" title="Prometheus Node Exporter">📊 EXPORTER</span>';
        }
        return '<span class="driver-badge driver-agent" style="background:rgba(59,130,246,0.15); color:#60a5fa; font-size:0.68rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(59,130,246,0.3);" title="PulseOps Native Agent">⚡ AGENT</span>';
    }

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

    // ── Status Filter & View Mode Controls ────────────────────────────────────

    function setStatusFilter(status) {
        _statusFilter = status;
        document.querySelectorAll('#fleet-status-tabs .checkcle-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.status === status);
        });
        renderFleet();
    }

    function setViewMode(mode) {
        _viewMode = mode;
        localStorage.setItem('pulseops-fleet-view', mode);
        document.querySelectorAll('.view-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === mode);
        });
        renderFleet();
    }

    // ── Render Fleet (Cards vs Table) ─────────────────────────────────────────

    function renderFleet() {
        const gridContainer  = document.getElementById('fleet-grid');
        const tableContainer = document.getElementById('fleet-table-container');
        const tableBody      = document.getElementById('fleet-table-body');

        // Apply View Mode layout toggle
        if (_viewMode === 'table') {
            if (gridContainer)  gridContainer.style.display  = 'none';
            if (tableContainer) tableContainer.style.display = 'block';
        } else {
            if (gridContainer)  gridContainer.style.display  = 'grid';
            if (tableContainer) tableContainer.style.display = 'none';
        }

        // Apply Tag Filter
        let filtered = _servers;
        if (_activeTag) {
            filtered = filtered.filter(s => (s.tags || []).includes(_activeTag));
        }

        // Apply Status Filter
        if (_statusFilter && _statusFilter !== 'all') {
            if (_statusFilter === 'offline') {
                filtered = filtered.filter(s => s.status === 'offline' || s.status === 'unreachable');
            } else {
                filtered = filtered.filter(s => s.status === _statusFilter);
            }
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
            const emptyHtml = `
                <div class="fleet-empty">
                    <div style="font-size:3rem; margin-bottom:1rem;">🖥️</div>
                    <h3 style="color:var(--text-muted); margin-bottom:0.5rem;">No servers found</h3>
                    <p style="color:var(--text-dim); font-size:0.9rem; margin-bottom:1.25rem;">
                        ${_searchQuery || _statusFilter !== 'all' ? 'Try adjusting your search query or status filter.' : 'Add your first server to get started with fleet monitoring.'}
                    </p>
                    ${(!_searchQuery && _statusFilter === 'all' && window.PulseOpsAuth && window.PulseOpsAuth.isAdmin()) ? `
                    <button class="btn-primary admin-only" onclick="window.openAddServerModal && window.openAddServerModal()">+ Add Server</button>
                    ` : ''}
                </div>`;
            if (gridContainer) gridContainer.innerHTML = emptyHtml;
            if (tableBody) tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:3rem 1rem; color:var(--text-dim); font-size:0.9rem;">No servers found matching current filters</td></tr>`;
            return;
        }

        if (gridContainer) {
            gridContainer.innerHTML = filtered.map(srv => buildServerCard(srv)).join('');
            attachCardListeners();
        }

        if (tableBody) {
            tableBody.innerHTML = filtered.map(srv => buildServerTableRow(srv)).join('');
            attachTableListeners();
        }
    }

    function buildServerCard(srv) {
        const sc     = getStatusConfig(srv.status);
        const cpu    = srv.latest_cpu != null ? srv.latest_cpu.toFixed(1) : '--';
        const mem    = srv.latest_mem != null ? srv.latest_mem.toFixed(1) : '--';
        const disk   = srv.latest_disk != null ? srv.latest_disk.toFixed(1) : '--';
        const uptime = formatUptime(srv.latest_uptime);
        const isMain = srv.host_ip === window.location.hostname || srv.host_ip === '127.0.0.1';
        const inMaintenance = srv.maintenance_until && new Date(srv.maintenance_until) > new Date();

        const cpuWidth  = srv.latest_cpu  != null ? Math.min(100, Math.max(0, srv.latest_cpu)).toFixed(0) : 0;
        const memWidth  = srv.latest_mem  != null ? Math.min(100, Math.max(0, srv.latest_mem)).toFixed(0) : 0;
        const diskWidth = srv.latest_disk != null ? Math.min(100, Math.max(0, srv.latest_disk)).toFixed(0) : 0;

        const driver = (srv.driver_type || 'agent').toLowerCase();
        const driverBadge = getDriverBadge(driver);
        const distroIcon = getDistroIcon(srv.os_info, 26);
        const displayName = srv.display_name || srv.hostname;

        const tagsHtml = (srv.tags || []).map(t => `<span class="server-tag">${t}</span>`).join('');

        return `
        <div class="server-card ${sc.cls}" data-server-id="${srv.id}" data-hostname="${srv.hostname}" tabindex="0">
            <div class="server-card-header">
                <div class="server-status-cluster">
                    <span class="server-status-pill ${srv.status}">
                        <span class="status-dot-mini ${srv.status}"></span>
                        <span>${sc.label}</span>
                    </span>
                    ${driverBadge}
                    ${inMaintenance ? '<span class="badge-maint" title="In Maintenance">🔧 Maint</span>' : ''}
                    ${isMain ? '<span class="badge-master">MASTER</span>' : ''}
                </div>
                ${(window.PulseOpsAuth && window.PulseOpsAuth.isAdmin()) ? `
                <div class="server-card-actions">
                    <button class="server-action-icon-btn" data-action="edit" data-server-id="${srv.id}" title="Edit server">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                    </button>
                    ${!isMain ? `
                    <button class="server-action-icon-btn danger" data-action="delete" data-server-id="${srv.id}" data-hostname="${displayName}" title="Remove server">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>` : ''}
                </div>` : ''}
            </div>

            <div class="server-card-identity">
                <div class="distro-avatar-box">${distroIcon}</div>
                <div class="server-card-identity-text">
                    <div class="server-card-name" title="${displayName}">${displayName}</div>
                    <div class="server-card-endpoint">
                        <span>${srv.host_ip}:${srv.agent_port}</span>
                        ${srv.os_info ? `<span class="server-endpoint-os">• ${srv.os_info.length > 24 ? srv.os_info.substring(0,24)+'...' : srv.os_info}</span>` : ''}
                    </div>
                </div>
            </div>

            ${driver === 'probe' ? `
            <div class="server-metrics-box probe-box">
                <div class="probe-metric-content">
                    <span class="probe-metric-label">Round-Trip Latency</span>
                    <span class="probe-metric-value">${srv.latest_load != null ? srv.latest_load + ' ms' : '--'}</span>
                </div>
            </div>` : `
            <div class="server-metrics-box">
                <div class="server-metric-item">
                    <span class="metric-item-label">CPU</span>
                    <div class="metric-item-track">
                        <div class="metric-item-fill" style="width:${cpuWidth}%; background:${getBarColor(cpuWidth)};"></div>
                    </div>
                    <span class="metric-item-value">${cpu}%</span>
                </div>
                <div class="server-metric-item">
                    <span class="metric-item-label">RAM</span>
                    <div class="metric-item-track">
                        <div class="metric-item-fill" style="width:${memWidth}%; background:${getBarColor(memWidth)};"></div>
                    </div>
                    <span class="metric-item-value">${mem}%</span>
                </div>
                <div class="server-metric-item">
                    <span class="metric-item-label">DISK</span>
                    <div class="metric-item-track">
                        <div class="metric-item-fill" style="width:${diskWidth}%; background:${getBarColor(diskWidth)};"></div>
                    </div>
                    <span class="metric-item-value">${disk}%</span>
                </div>
            </div>`}

            <div class="server-card-footer">
                <div class="server-card-meta-left">
                    <span class="uptime-badge" title="Uptime">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>
                        <span>${uptime}</span>
                    </span>
                    ${tagsHtml}
                </div>
                <div class="server-card-meta-right">
                    <span class="last-seen-indicator ${srv.status === 'online' ? 'live' : ''}">
                        ${srv.status === 'online' ? '<span class="status-dot-mini online"></span> Live' : 'Last: ' + (srv.last_seen ? new Date(srv.last_seen).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Never')}
                    </span>
                </div>
            </div>
        </div>`;
    }

    function buildServerTableRow(srv) {
        const sc          = getStatusConfig(srv.status);
        const cpu         = srv.latest_cpu != null ? srv.latest_cpu.toFixed(1) : '--';
        const mem         = srv.latest_mem != null ? srv.latest_mem.toFixed(1) : '--';
        const disk        = srv.latest_disk != null ? srv.latest_disk.toFixed(1) : '--';
        const uptime      = formatUptime(srv.latest_uptime);
        const isMain      = srv.host_ip === window.location.hostname || srv.host_ip === '127.0.0.1';
        const driver      = (srv.driver_type || 'agent').toLowerCase();
        const driverBadge = getDriverBadge(driver);
        const distroIcon  = getDistroIcon(srv.os_info, 20);

        const cpuNum  = srv.latest_cpu  != null ? Math.min(100, Math.max(0, srv.latest_cpu)) : 0;
        const memNum  = srv.latest_mem  != null ? Math.min(100, Math.max(0, srv.latest_mem)) : 0;
        const diskNum = srv.latest_disk != null ? Math.min(100, Math.max(0, srv.latest_disk)) : 0;

        const displayName = srv.display_name || srv.hostname;
        const osLabel     = srv.os_info ? (srv.os_info.length > 28 ? srv.os_info.substring(0, 28) + '...' : srv.os_info) : 'Linux';

        return `
        <tr class="checkcle-row" data-server-id="${srv.id}" data-hostname="${srv.hostname}">
            <td>
                <span class="server-status-pill ${srv.status}">
                    <span class="status-dot-mini ${srv.status}"></span>
                    <span>${sc.label}</span>
                </span>
            </td>
            <td>
                <div class="server-col-cell">
                    <div class="server-cell-icon">${distroIcon}</div>
                    <div class="server-cell-info">
                        <span class="server-cell-name">${displayName} ${isMain ? '<span class="badge-master">MASTER</span>' : ''}</span>
                        <span class="server-cell-os">${osLabel}</span>
                    </div>
                </div>
            </td>
            <td>
                <div class="server-col-endpoint">
                    <code class="endpoint-code">${srv.host_ip}:${srv.agent_port}</code>
                    ${driverBadge}
                </div>
            </td>
            <td>
                <div class="table-metric-cell">
                    <div class="table-bar-track">
                        <div class="table-bar-fill" style="width:${cpuNum}%; background:${getBarColor(cpuNum)};"></div>
                    </div>
                    <span class="table-metric-val">${cpu}%</span>
                </div>
            </td>
            <td>
                <div class="table-metric-cell">
                    <div class="table-bar-track">
                        <div class="table-bar-fill" style="width:${memNum}%; background:${getBarColor(memNum)};"></div>
                    </div>
                    <span class="table-metric-val">${mem}%</span>
                </div>
            </td>
            <td>
                <div class="table-metric-cell">
                    <div class="table-bar-track">
                        <div class="table-bar-fill" style="width:${diskNum}%; background:${getBarColor(diskNum)};"></div>
                    </div>
                    <span class="table-metric-val">${disk}%</span>
                </div>
            </td>
            <td>
                <span class="table-latency-val">
                    ${driver === 'probe' ? (srv.latest_load != null ? srv.latest_load + ' ms' : '--') : (srv.status === 'online' ? 'Active' : '--')}
                </span>
            </td>
            <td>
                <span class="table-uptime-val">${uptime}</span>
            </td>
            <td style="text-align:right;">
                <div class="table-actions-cell">
                    <button class="server-action-icon-btn" data-action="open" data-server-id="${srv.id}" data-hostname="${srv.hostname}" title="Open Dashboard">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                    </button>
                    ${(window.PulseOpsAuth && window.PulseOpsAuth.isAdmin()) ? `
                        <button class="server-action-icon-btn" data-action="edit" data-server-id="${srv.id}" title="Edit server">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        ${!isMain ? `
                        <button class="server-action-icon-btn danger" data-action="delete" data-server-id="${srv.id}" data-hostname="${displayName}" title="Delete server">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </button>` : ''}
                    ` : ''}
                </div>
            </td>
        </tr>`;
    }

    function attachCardListeners() {
        document.querySelectorAll('.server-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.server-action-icon-btn') || e.target.closest('.server-card-actions')) return;
                const serverId = card.dataset.serverId;
                openServerDashboard(serverId, card.dataset.hostname);
            });

            card.querySelectorAll('.server-action-icon-btn').forEach(btn => {
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

    function attachTableListeners() {
        const tableBody = document.getElementById('fleet-table-body');
        if (!tableBody) return;

        tableBody.querySelectorAll('.checkcle-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.server-action-icon-btn') || e.target.closest('.table-actions-cell')) return;
                const serverId = row.dataset.serverId;
                const hostname = row.dataset.hostname;
                openServerDashboard(serverId, hostname);
            });

            row.querySelectorAll('.server-action-icon-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    const action   = btn.dataset.action;
                    const serverId = btn.dataset.serverId;
                    if (action === 'open') {
                        openServerDashboard(serverId, btn.dataset.hostname);
                    } else if (action === 'delete') {
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
        const offlineTotal = (counts.offline || 0) + (counts.unreachable || 0);

        // Update Stat Cards
        setText('fleet-stat-total',      total);
        setText('fleet-stat-online',     counts.online || 0);
        setText('fleet-stat-degraded',   counts.degraded || 0);
        setText('fleet-stat-offline',    offlineTotal);

        // Update Status Filter Tabs
        setText('tab-count-all',         total);
        setText('tab-count-online',      counts.online || 0);
        setText('tab-count-degraded',    counts.degraded || 0);
        setText('tab-count-offline',     offlineTotal);

        // Update Header Global Health Status Pill
        const dot = document.getElementById('global-health-dot');
        const txt = document.getElementById('global-health-text');
        if (dot && txt) {
            if (offlineTotal > 0) {
                dot.className = 'status-dot-mini offline';
                txt.textContent = `${offlineTotal} Server${offlineTotal > 1 ? 's' : ''} Down`;
            } else if ((counts.degraded || 0) > 0) {
                dot.className = 'status-dot-mini degraded';
                txt.textContent = `${counts.degraded} Server${counts.degraded > 1 ? 's' : ''} Degraded`;
            } else if (total > 0) {
                dot.className = 'status-dot-mini online';
                txt.textContent = 'All Systems Operational';
            } else {
                dot.className = 'status-dot-mini';
                txt.textContent = 'No Servers Monitored';
            }
        }
    }

    function setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    // ── Fleet Update via WebSocket ─────────────────────────────────────────────

    function handleFleetUpdate(payload) {
        const idx = _servers.findIndex(s => s.id === payload.server_id);
        if (idx !== -1) {
            _servers[idx].status = payload.status;
            if (payload.snapshot) {
                _servers[idx].latest_cpu    = payload.snapshot.cpu_percent;
                _servers[idx].latest_mem    = payload.snapshot.mem_percent;
                _servers[idx].latest_disk   = payload.snapshot.disk_percent;
                _servers[idx].latest_uptime = payload.snapshot.uptime;
            }
            // Update Card if present
            const card = document.querySelector(`.server-card[data-server-id="${payload.server_id}"]`);
            if (card) {
                const newCard = document.createElement('div');
                newCard.innerHTML = buildServerCard(_servers[idx]);
                const newEl = newCard.firstElementChild;
                card.replaceWith(newEl);
                newEl.addEventListener('click', (e) => {
                    if (!e.target.closest('.server-action-icon-btn') && !e.target.closest('.server-card-actions')) {
                        openServerDashboard(newEl.dataset.serverId, newEl.dataset.hostname);
                    }
                });
                newEl.querySelectorAll('.server-action-icon-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        const action = btn.dataset.action;
                        if (action === 'delete') {
                            confirmDeleteServer(payload.server_id, btn.dataset.hostname);
                        } else if (action === 'edit') {
                            openEditServerModal(payload.server_id);
                        }
                    });
                });
            }
            // Update Table row if present
            const row = document.querySelector(`.checkcle-row[data-server-id="${payload.server_id}"]`);
            if (row) {
                const newRowHolder = document.createElement('tbody');
                newRowHolder.innerHTML = buildServerTableRow(_servers[idx]);
                const newRow = newRowHolder.firstElementChild;
                row.replaceWith(newRow);
                newRow.addEventListener('click', (e) => {
                    if (!e.target.closest('.server-action-icon-btn') && !e.target.closest('.table-actions-cell')) {
                        openServerDashboard(newRow.dataset.serverId, newRow.dataset.hostname);
                    }
                });
                newRow.querySelectorAll('.server-action-icon-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        const action = btn.dataset.action;
                        if (action === 'open') {
                            openServerDashboard(payload.server_id, btn.dataset.hostname);
                        } else if (action === 'delete') {
                            confirmDeleteServer(payload.server_id, btn.dataset.hostname);
                        } else if (action === 'edit') {
                            openEditServerModal(payload.server_id);
                        }
                    });
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
        // Search & Clear button
        const searchInput = document.getElementById('fleet-search-input');
        const clearBtn    = document.getElementById('fleet-search-clear');
        const kbdHint     = document.getElementById('fleet-search-kbd');
        if (searchInput) {
            let debounce;
            searchInput.addEventListener('input', () => {
                clearTimeout(debounce);
                _searchQuery = searchInput.value.trim();
                if (clearBtn) clearBtn.style.display = _searchQuery ? 'block' : 'none';
                if (kbdHint)  kbdHint.style.display  = _searchQuery ? 'none' : 'block';
                debounce = setTimeout(() => loadServers(), 250);
            });
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    searchInput.value = '';
                    _searchQuery = '';
                    clearBtn.style.display = 'none';
                    if (kbdHint) kbdHint.style.display = 'block';
                    loadServers();
                });
            }
        }

        // Global Ctrl+K / Cmd+K shortcut to focus search when on Fleet view
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                const targetSec = document.getElementById('section-fleet');
                if (targetSec && targetSec.classList.contains('active')) {
                    e.preventDefault();
                    if (searchInput) {
                        searchInput.focus();
                        searchInput.select();
                    }
                }
            }
        });

        // Checkcle Status Filter Tabs
        document.querySelectorAll('#fleet-status-tabs .checkcle-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                setStatusFilter(btn.dataset.status);
            });
        });

        // Checkcle Stat Cards click-to-filter
        document.querySelectorAll('.fleet-stat-card[data-status-filter]').forEach(card => {
            card.addEventListener('click', () => {
                setStatusFilter(card.dataset.statusFilter);
            });
        });

        // Checkcle View Mode Switcher (Cards vs Table)
        const viewGridBtn  = document.getElementById('fleet-view-grid');
        const viewTableBtn = document.getElementById('fleet-view-table');
        if (viewGridBtn)  viewGridBtn.addEventListener('click',  () => setViewMode('grid'));
        if (viewTableBtn) viewTableBtn.addEventListener('click', () => setViewMode('table'));

        if (_viewMode === 'table') {
            if (viewTableBtn) viewTableBtn.classList.add('active');
            if (viewGridBtn)  viewGridBtn.classList.remove('active');
        } else {
            if (viewGridBtn)  viewGridBtn.classList.add('active');
            if (viewTableBtn) viewTableBtn.classList.remove('active');
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
        setStatusFilter,
        setViewMode,
        getDistroIcon,
        getServers: () => _servers,
    };
    window.PulseOpsFleet = api;
    window.getDistroIcon = getDistroIcon;
    window.openAddServerModal = openAddServerModal;
    window.openServerDashboard = openServerDashboard;
    window.confirmDeleteFleetServer = confirmDeleteServer;
    return api;
})();

