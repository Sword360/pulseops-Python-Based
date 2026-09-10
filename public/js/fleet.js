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
                    <p style="color:var(--text-dim); font-size:0.9rem;">
                        ${_searchQuery ? 'Try a different search query.' : 'Add your first server to get started.'}
                    </p>
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

        return `
        <div class="server-card ${sc.cls}" data-server-id="${srv.id}" data-hostname="${srv.hostname}" tabindex="0">
            <div class="server-card-header">
                <div class="server-status-row">
                    <span class="server-status-dot ${sc.cls}"></span>
                    <span class="server-status-label">${sc.label}</span>
                    ${inMaintenance ? '<span class="maintenance-badge" title="In Maintenance">🔧 Maintenance</span>' : ''}
                    ${isMain ? '<span class="main-badge">MASTER</span>' : ''}
                </div>
                ${PulseOpsAuth.isAdmin() ? `
                <div class="server-card-actions">
                    <button class="server-action-btn" data-action="edit" data-server-id="${srv.id}" title="Edit server">✏️</button>
                    <button class="server-action-btn danger" data-action="delete" data-server-id="${srv.id}" data-hostname="${srv.hostname}" title="Remove server">🗑️</button>
                </div>` : ''}
            </div>

            <div class="server-hostname">${srv.display_name || srv.hostname}</div>
            <div class="server-ip">${srv.host_ip}:${srv.agent_port}</div>
            ${srv.os_info ? `<div class="server-os">${srv.os_info.length > 35 ? srv.os_info.substring(0,35)+'...' : srv.os_info}</div>` : ''}

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
            </div>

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
                if (e.target.closest('.server-action-btn')) return;
                const serverId = card.dataset.serverId;
                openServerDashboard(serverId, card.dataset.hostname);
            });

            // Action buttons
            card.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
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

    function openAddServerModal() {
        const modal = document.getElementById('add-server-modal');
        if (modal) {
            modal.style.display = 'flex';
            document.getElementById('new-server-hostname').value = '';
            document.getElementById('new-server-ip').value = '';
            document.getElementById('new-server-displayname').value = '';
            document.getElementById('new-server-port').value = '3500';
            document.getElementById('new-server-tags').value = '';
            document.getElementById('new-server-notes').value = '';
            document.getElementById('add-server-tab-manual').click();
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
        modal.style.display = 'flex';
    }

    async function confirmDeleteServer(serverId, hostname) {
        if (!confirm(`Remove server "${hostname}" from the fleet?\n\nThis will delete all stored snapshots and alert history for this server.`)) return;
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/fleet/servers/${serverId}`, { method: 'DELETE' });
            if (resp && resp.ok) {
                _servers = _servers.filter(s => s.id !== serverId);
                renderFleet();
                updateSummaryStats();
                showToast(`Server "${hostname}" removed from fleet`, 'success');
            } else {
                showToast('Failed to remove server', 'error');
            }
        } catch (e) {
            showToast('Error removing server', 'error');
        }
    }

    // ── Add Server Submit (manual) ────────────────────────────────────────────

    async function submitAddServer() {
        const hostname = document.getElementById('new-server-hostname').value.trim();
        const host_ip  = document.getElementById('new-server-ip').value.trim();
        const display_name = document.getElementById('new-server-displayname').value.trim();
        const agent_port   = parseInt(document.getElementById('new-server-port').value) || 3500;
        const tags_raw     = document.getElementById('new-server-tags').value.trim();
        const notes        = document.getElementById('new-server-notes').value.trim();
        const tags = tags_raw ? tags_raw.split(',').map(t => t.trim()).filter(Boolean) : [];

        if (!hostname || !host_ip) {
            showToast('Hostname and IP are required', 'error'); return;
        }

        const btn = document.getElementById('add-server-submit-btn');
        btn.disabled = true; btn.textContent = 'Adding...';
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/fleet/servers', {
                method: 'POST',
                body: JSON.stringify({ hostname, host_ip, display_name, agent_port, tags, notes }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Server "${hostname}" added! Token: ${data.agent_token.substring(0,8)}...`, 'success');
                document.getElementById('add-server-modal').style.display = 'none';
                loadServers();
            } else {
                showToast(data.detail || data.error || 'Failed to add server', 'error');
            }
        } catch { showToast('Network error', 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Add Server'; }
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
            const curlCmd = `curl -sSL "${masterUrl}/api/fleet/agent-install.sh?token=${token}" | bash`;

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
                if (modal) modal.style.display = 'none';
            });
        });

        // Agent install token
        const genBtn = document.getElementById('generate-token-btn');
        if (genBtn) genBtn.addEventListener('click', generateInviteToken);

        // Copy curl command
        const copyBtn = document.getElementById('copy-curl-btn');
        if (copyBtn) copyBtn.addEventListener('click', () => {
            const cmd = document.getElementById('agent-curl-cmd').textContent;
            navigator.clipboard.writeText(cmd).then(() => showToast('Copied to clipboard!', 'success'));
        });

        // Add server modal tabs
        const tabManual = document.getElementById('add-server-tab-manual');
        const tabAgent  = document.getElementById('add-server-tab-agent');
        if (tabManual && tabAgent) {
            tabManual.addEventListener('click', () => switchModalTab('manual'));
            tabAgent.addEventListener('click', () => switchModalTab('agent'));
        }

        // Edit server save
        const editSaveBtn = document.getElementById('edit-server-save-btn');
        if (editSaveBtn) editSaveBtn.addEventListener('click', submitEditServer);

        // Initial load
        loadServers().then(() => buildTagFilters());

        // Auto-refresh every 30 seconds
        setInterval(loadServers, 30000);
    }

    function switchModalTab(tab) {
        const manualPane = document.getElementById('add-server-manual-pane');
        const agentPane  = document.getElementById('add-server-agent-pane');
        const tabManual  = document.getElementById('add-server-tab-manual');
        const tabAgent   = document.getElementById('add-server-tab-agent');

        if (tab === 'manual') {
            manualPane.style.display = 'block';
            agentPane.style.display = 'none';
            tabManual.classList.add('active');
            tabAgent.classList.remove('active');
        } else {
            manualPane.style.display = 'none';
            agentPane.style.display = 'block';
            tabAgent.classList.add('active');
            tabManual.classList.remove('active');
            // Reset token display
            const tokenDisplay = document.getElementById('agent-token-display');
            if (tokenDisplay) tokenDisplay.style.display = 'none';
        }
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
                document.getElementById('edit-server-modal').style.display = 'none';
                loadServers();
            } else {
                showToast('Failed to update server', 'error');
            }
        } catch { showToast('Network error', 'error'); }
    }

    // Public API
    return {
        init,
        loadServers,
        handleFleetUpdate,
        renderFleet,
    };
})();
