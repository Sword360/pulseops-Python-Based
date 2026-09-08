/**
 * app.js — PulseOps Enterprise Core Orchestrator
 *
 * Handles authentication-aware initialization, section navigation,
 * sidebar control, WebSocket telemetry with auth, breadcrumbs,
 * user header population, role-based UI visibility, and toast notifications.
 */

/* ─── Global helpers (used by other modules) ─────────────────────────────────
   These are defined before any module code executes.                          */

function showSection(name) {
    document.querySelectorAll('.app-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`section-${name}`);
    if (target) target.classList.add('active');

    // Update sidebar active state
    document.querySelectorAll('.sidebar-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === name);
    });

    // Show/hide server-specific header
    const connStatus = document.getElementById('header-conn-status');
    if (connStatus) connStatus.style.display = name === 'server-dashboard' ? 'flex' : 'none';

    // If opening server dashboard, ensure charts are properly sized and hydrated
    if (name === 'server-dashboard') {
        setTimeout(() => {
            if (window.PulseOpsApp) {
                if (typeof window.PulseOpsApp.resizeCharts === 'function') window.PulseOpsApp.resizeCharts();
                if (typeof window.PulseOpsApp.loadServerHistory === 'function') window.PulseOpsApp.loadServerHistory();
            }
        }, 50);
    }
}

function updateBreadcrumb(crumbs) {
    const bc = document.getElementById('breadcrumb');
    if (!bc) return;
    bc.innerHTML = crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        if (isLast) return `<span class="breadcrumb-item active">${c.label}</span>`;
        return `<span class="breadcrumb-item link" onclick="${c.action ? '' : `showSection('${c.label.toLowerCase()}')`}" style="cursor:pointer;">${c.label}</span><span class="breadcrumb-sep">›</span>`;
    }).join('');
    crumbs.forEach((c, i) => {
        if (c.action) {
            const items = bc.querySelectorAll('.breadcrumb-item.link');
            if (items[i]) items[i].addEventListener('click', c.action);
        }
    });
}

function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
        <span class="toast-msg">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    // Auto-dismiss
    setTimeout(() => {
        toast.classList.remove('toast-visible');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Make showSection and showToast global for use from HTML event handlers
window.showSection  = showSection;
window.showToast    = showToast;
window.updateBreadcrumb = updateBreadcrumb;

/* ─── Main Dashboard Class ────────────────────────────────────────────────── */

class PulseOpsDashboard {
    constructor() {
        this.ws          = null;
        this.cpuChart    = null;
        this.memChart    = null;
        this.netChart    = null;
        this.currentUser = null;
        this.wsReconnectTimer = null;
        this.wsReconnectDelay = 2000;

        this.alertThresholds = { cpu: 85, memory: 90 };
        this.currentServerId = 'local-master';
        this.serverPollTimer = null;
        window.PulseOpsApp = this;
    }

    // ── Boot Sequence ─────────────────────────────────────────────────────────

    async init() {
        // Initialize UI shell immediately so the app is interactive & responsive
        this.initTheme();
        this.initToastSystem();
        this.initSidebar();
        this.initTabs();
        this.initCharts();
        this.initUserMenu();
        this.initModalSystem();

        // Wait for auth to complete
        this.currentUser = await PulseOpsAuth.requireAuth();
        if (!this.currentUser) return; // Redirected to login

        this.applyUserContext();
        this.connectWebSocket();
        this.initModules();
        this.updateSidebarServers();
    }

    // ── User Context ──────────────────────────────────────────────────────────

    applyUserContext() {
        const user = this.currentUser;

        // Header user info
        const name    = document.getElementById('header-user-name');
        const role    = document.getElementById('header-user-role');
        const avatar  = document.getElementById('user-avatar-sm');
        const avatarLg = document.getElementById('user-avatar-lg');
        const ddName  = document.getElementById('dropdown-user-name');
        const ddEmail = document.getElementById('dropdown-user-email');
        const ddRole  = document.getElementById('dropdown-user-role');

        if (name)    name.textContent    = user.display_name || user.email;
        if (role)    role.textContent    = user.role.charAt(0).toUpperCase() + user.role.slice(1);
        if (avatar)  avatar.textContent  = this._initials(user.display_name);
        if (avatarLg) avatarLg.textContent = this._initials(user.display_name);
        if (ddName)  ddName.textContent  = user.display_name || user.email;
        if (ddEmail) ddEmail.textContent = user.email;
        if (ddRole) {
            ddRole.textContent = user.role;
            ddRole.className   = `role-badge role-${user.role}`;
        }

        // Set avatar color
        const color = this._avatarColor(user.email);
        if (avatar)   avatar.style.background   = color;
        if (avatarLg) avatarLg.style.background = color;

        if (user && user.role) {
            document.documentElement.setAttribute('data-role', user.role);
            if (document.body) document.body.setAttribute('data-role', user.role);
        }

        // Role-based visibility
        const isAdmin    = user.role === 'admin';
        const isOperator = ['admin', 'operator'].includes(user.role);

        document.querySelectorAll('.admin-only').forEach(el => {
            el.style.display = isAdmin ? '' : 'none';
        });
        document.querySelectorAll('.operator-only').forEach(el => {
            el.style.display = isOperator ? '' : 'none';
        });

        // If viewer is currently on terminal tab, switch back to overview
        if (!isOperator) {
            const currentActiveTab = document.querySelector('#section-server-dashboard .nav-tabs .tab-btn.active');
            if (currentActiveTab && currentActiveTab.dataset.tab === 'terminal') {
                const dashBtn = document.querySelector('#section-server-dashboard .nav-tabs .tab-btn[data-tab="dashboard"]') ||
                                document.querySelector('#section-server-dashboard .nav-tabs .tab-btn[data-tab="overview"]');
                if (dashBtn) dashBtn.click();
            }
        }

        // Populate sidebar servers list
        this.updateSidebarServers();
    }

    _initials(name) {
        return (name || '??').split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase();
    }

    _avatarColor(email) {
        let hash = 0;
        for (const c of (email || '')) hash = c.charCodeAt(0) + ((hash << 5) - hash);
        const colors = ['#38bdf8','#818cf8','#a855f7','#22c55e','#f59e0b','#ef4444'];
        return colors[Math.abs(hash) % colors.length];
    }

    // ── Sidebar ───────────────────────────────────────────────────────────────

    initSidebar() {
        const sidebar   = document.getElementById('sidebar');
        const wrapper   = document.getElementById('main-wrapper');
        const collapseBtn = document.getElementById('sidebar-collapse-btn');
        const toggleBtn   = document.getElementById('sidebar-toggle-btn');

        // Check stored state
        const collapsed = localStorage.getItem('pulseops-sidebar-collapsed') === 'true';
        if (collapsed) this._collapseSidebar(true);

        collapseBtn?.addEventListener('click', () => {
            const isCollapsed = sidebar.classList.contains('collapsed');
            this._collapseSidebar(!isCollapsed);
            localStorage.setItem('pulseops-sidebar-collapsed', !isCollapsed);
        });

        toggleBtn?.addEventListener('click', () => {
            const isCollapsed = sidebar.classList.contains('collapsed');
            this._collapseSidebar(!isCollapsed);
        });

        // Section navigation
        document.querySelectorAll('.sidebar-btn[data-section]').forEach(btn => {
            btn.addEventListener('click', () => {
                const section = btn.dataset.section;
                showSection(section);
                updateBreadcrumb([{ label: btn.querySelector('.sidebar-label')?.textContent || section }]);

                // Refresh data for target section
                if (section === 'fleet' && window.PulseOpsFleet) window.PulseOpsFleet.loadServers();
                if (section === 'users' && window.UsersManager) window.UsersManager.loadUsers();
                if (section === 'alerts' && window.AlertsManager) {
                    window.AlertsManager.loadActiveAlerts();
                    window.AlertsManager.loadAlertRules();
                }
                if (section === 'audit' && window.AuditViewer) window.AuditViewer.loadAuditLog(1);
                if (section === 'settings' && window.SettingsManager) window.SettingsManager.loadSettings();

                // If navigating away from server dashboard, pause remote polling
                if (section !== 'server-dashboard' && this.serverPollTimer) {
                    clearInterval(this.serverPollTimer);
                    this.serverPollTimer = null;
                }

                // Mobile: collapse sidebar after nav
                if (window.innerWidth < 768) this._collapseSidebar(true);
            });
        });

        // Fleet overview is default
        showSection('fleet');
    }

    _collapseSidebar(collapse) {
        const sidebar    = document.getElementById('sidebar');
        const wrapper    = document.getElementById('main-wrapper');
        const collapseBtn = document.getElementById('sidebar-collapse-btn');
        if (!sidebar) return;

        if (collapse) {
            sidebar.classList.add('collapsed');
            wrapper?.classList.add('sidebar-collapsed');
            if (collapseBtn) collapseBtn.textContent = '▶';
        } else {
            sidebar.classList.remove('collapsed');
            wrapper?.classList.remove('sidebar-collapsed');
            if (collapseBtn) collapseBtn.textContent = '◀';
        }
    }

    // ── Tabs (server dashboard sub-navigation) ────────────────────────────────

    initTabs() {
        const container = document.getElementById('section-server-dashboard');
        if (!container) return;

        container.querySelectorAll('.nav-tabs .tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.tab === 'terminal' && window.PulseOpsAuth && !window.PulseOpsAuth.isOperator()) {
                    window.showToast && window.showToast('Access denied: Web Terminal is restricted to Operators and Admins', 'error');
                    return;
                }
                container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                container.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const target = document.getElementById(`${btn.dataset.tab}-tab`);
                if (target) target.classList.add('active');

                // Lazy-load tab data
                if (btn.dataset.tab === 'overview' || btn.dataset.tab === 'dashboard') {
                    this.resizeCharts();
                    this.loadServerHistory(this.currentServerId);
                }
                if (btn.dataset.tab === 'services'  && window.systemdMgr) window.systemdMgr.loadServices();
                if (btn.dataset.tab === 'processes' && window.procMgr)    window.procMgr.loadProcesses();
                if (btn.dataset.tab === 'vnc'       && window.vncMgr)     window.vncMgr.checkHostVncStatus();
                if (btn.dataset.tab === 'terminal'  && window.webTerminal) {
                    if (typeof window.webTerminal.onTabActivated === 'function') {
                        window.webTerminal.onTabActivated();
                    }
                    if (window.webTerminal.input) {
                        setTimeout(() => window.webTerminal.input.focus(), 80);
                    }
                }
            });
        });
    }

    // ── User Menu Dropdown ────────────────────────────────────────────────────

    initUserMenu() {
        const btn      = document.getElementById('user-menu-btn');
        const dropdown = document.getElementById('user-dropdown');
        if (!btn || !dropdown) return;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        });
        document.addEventListener('click', () => { dropdown.style.display = 'none'; });
    }

    // ── Theme Persistence ─────────────────────────────────────────────────────

    initTheme() {
        const saved = localStorage.getItem('pulseops-theme') || 'dark';
        this.applyTheme(saved);

        document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const current = localStorage.getItem('pulseops-theme') || 'dark';
                const next = current === 'dark' ? 'light' : 'dark';
                this.applyTheme(next);
                showToast(`${next === 'dark' ? 'Dark' : 'Light'} mode enabled`, 'info');
            });
        });
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('pulseops-theme', theme);
        document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
            btn.textContent = theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
        });
    }

    // ── Modules Initialization ────────────────────────────────────────────────

    initModules() {
        // Fleet
        if (typeof FleetManager !== 'undefined') FleetManager.init();
        // Users (admin only)
        if (typeof UsersManager !== 'undefined' && this.currentUser?.role === 'admin') UsersManager.init();
        // Alerts
        if (typeof AlertsManager !== 'undefined') AlertsManager.init();
        // Audit (admin only)
        if (typeof AuditViewer !== 'undefined' && this.currentUser?.role === 'admin') AuditViewer.init();
        // Settings (admin only)
        if (typeof SettingsManager !== 'undefined' && this.currentUser?.role === 'admin') SettingsManager.init();

        // Server dashboard: listen for server selection
        document.addEventListener('pulseops:server:selected', (e) => {
            this._onServerSelected(e.detail);
        });
    }

    selectServer(serverId, hostname) {
        this.currentServerId = serverId;
        window.PulseOpsCurrentServer = serverId;
        window.PulseOpsCurrentServerHostname = hostname;

        showSection('server-dashboard');
        updateBreadcrumb([
            { label: 'Fleet', action: () => showSection('fleet') },
            { label: hostname || serverId },
        ]);

        this._onServerSelected({ serverId, hostname });
    }

    _onServerSelected({ serverId, hostname }) {
        this.currentServerId = serverId || 'local-master';
        window.PulseOpsCurrentServer = this.currentServerId;
        window.PulseOpsCurrentServerHostname = hostname;

        // Update active class on sidebar server buttons
        document.querySelectorAll('.sidebar-server-item').forEach(b => {
            b.classList.toggle('active', b.dataset.serverId === this.currentServerId);
        });

        const btn = document.querySelector(`.sidebar-server-item[data-server-id="${this.currentServerId}"]`);
        const ip = btn ? btn.dataset.ip : '';
        const port = btn ? btn.dataset.port : '';
        const os = btn ? btn.dataset.os : '';

        const isMaster = !this.currentServerId || this.currentServerId === 'local-master';
        const displayHost = hostname || (isMaster ? 'mail.sword.local' : (btn?.dataset.hostname || 'Server'));

        // Pre-hydrate identity bar immediately with known data to avoid placeholder flicker
        this._setText('server-identity-hostname', isMaster ? `${displayHost} (Master)` : displayHost);
        if (ip) {
            this._setText('server-identity-ip', `${ip}:${port || (isMaster ? 3500 : 3501)}`);
        }
        if (os) {
            this._setText('server-identity-os', os);
        }
        this._setText('header-hostname', displayHost);

        const hostCtrlLbl = document.getElementById('host-ctrl-target-label');
        if (hostCtrlLbl) hostCtrlLbl.textContent = `Target: ${displayHost}`;

        if (window.webTerminal && typeof window.webTerminal.setServer === 'function') {
            window.webTerminal.setServer(this.currentServerId, displayHost, ip);
        }

        const noticeEl = document.getElementById('remote-node-tab-notice');
        const noticeNameEl = document.getElementById('remote-node-notice-name');

        // Immediately hydrate usage charts with real historical snapshots
        this.loadServerHistory(this.currentServerId);
        setTimeout(() => this.resizeCharts(), 50);

        // Refresh currently active subtab (processes/services/etc.) for newly selected server
        const activeTab = document.querySelector('#section-server-dashboard .nav-tabs .tab-btn.active')?.dataset.tab || 'overview';
        if (activeTab === 'processes' && window.procMgr) window.procMgr.loadProcesses();
        if (activeTab === 'services' && window.systemdMgr) window.systemdMgr.loadServices();

        // Dashboard Remove Server button visibility (Admin only)
        const removeBtn = document.getElementById('btn-dashboard-remove-server');
        if (removeBtn) {
            const isAdmin = window.PulseOpsAuth && window.PulseOpsAuth.isAdmin();
            if (isMaster || !isAdmin) {
                removeBtn.style.display = 'none';
            } else {
                removeBtn.style.display = 'inline-flex';
                removeBtn.onclick = () => {
                    const sid = this.currentServerId;
                    const hname = window.PulseOpsCurrentServerHostname || hostname || 'Remote Server';
                    if (window.confirmDeleteFleetServer) {
                        window.confirmDeleteFleetServer(sid, hname);
                    }
                };
            }
        }

        if (isMaster) {
            if (noticeEl) noticeEl.style.display = 'none';
            if (this.serverPollTimer) {
                clearInterval(this.serverPollTimer);
                this.serverPollTimer = null;
            }
            // Request fresh master telemetry
            if (this.ws && this.ws.readyState === 1) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        } else {
            if (noticeEl) {
                noticeEl.style.display = 'flex';
                if (noticeNameEl) noticeNameEl.textContent = `${displayHost} (${serverId.substring(0, 8)}...)`;
                noticeEl.innerHTML = `<span>⚡ Live Fleet Node: <strong>${displayHost}</strong> | Full Remote Management Active (Terminal, Services, Processes & Telemetry connected to this host).</span>`;
            }

            // Immediately load remote server details & snapshot
            this.loadServerData(this.currentServerId);

            // Start background polling for remote node telemetry
            if (this.serverPollTimer) clearInterval(this.serverPollTimer);
            this.serverPollTimer = setInterval(() => {
                if (this.currentServerId && this.currentServerId !== 'local-master') {
                    this.loadServerData(this.currentServerId, true);
                } else {
                    clearInterval(this.serverPollTimer);
                    this.serverPollTimer = null;
                }
            }, 3000);
        }
    }

    resizeCharts() {
        if (this.cpuChart && typeof this.cpuChart.resize === 'function') this.cpuChart.resize();
        if (this.memChart && typeof this.memChart.resize === 'function') this.memChart.resize();
        if (this.netChart && typeof this.netChart.resize === 'function') this.netChart.resize();
    }

    async loadServerHistory(serverId) {
        const sid = serverId || this.currentServerId || 'local-master';
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/fleet/servers/${encodeURIComponent(sid)}/snapshots?limit=30`);
            if (!resp || !resp.ok) return;
            const res = await resp.json();
            if (res.success && Array.isArray(res.snapshots) && res.snapshots.length > 0) {
                const cpus = res.snapshots.map(s => Number(s.cpu_percent) || 0);
                const mems = res.snapshots.map(s => Number(s.mem_percent) || 0);
                const rx = res.snapshots.map(s => (Number(s.net_rx_sec) || 0) / 1024);
                const tx = res.snapshots.map(s => (Number(s.net_tx_sec) || 0) / 1024);

                if (this.cpuChart && typeof this.cpuChart.setSeries === 'function') {
                    this.cpuChart.setSeries(cpus);
                }
                if (this.memChart && typeof this.memChart.setSeries === 'function') {
                    this.memChart.setSeries(mems);
                }
                if (this.netChart && typeof this.netChart.setSeries === 'function') {
                    this.netChart.setSeries(rx, tx);
                }
            }
        } catch (e) {
            console.warn('[App] Failed to load server snapshots:', e);
        }
    }

    async loadServerData(serverId, silent = false) {
        if (!serverId || serverId === 'local-master') return;
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/fleet/servers/${serverId}`);
            if (!resp || !resp.ok) return;
            const srv = await resp.json();
            if (this.currentServerId === serverId) {
                this.renderServerData(srv);
            }
        } catch (e) {
            if (!silent) console.error('[App] Failed to load server data:', e);
        }
    }

    renderServerData(srv) {
        if (!srv) return;
        const isMaster = (srv.id || this.currentServerId) === 'local-master';

        // Merge with existing server cache so partial updates (e.g. from fleet WS) don't wipe identity
        if (this._currentServerMeta && (this._currentServerMeta.id === srv.id || !srv.id)) {
            srv = {
                ...this._currentServerMeta,
                ...srv,
                latest_snapshot: { ...(this._currentServerMeta.latest_snapshot || {}), ...(srv.latest_snapshot || {}) }
            };
        }
        if (srv.id) {
            this._currentServerMeta = srv;
        }

        const snap = srv.latest_snapshot || {};

        // Identity
        const displayName = srv.display_name || srv.hostname || (isMaster ? 'Master Node' : 'Server');
        const hostname = srv.hostname || displayName;
        this._setText('server-identity-hostname', isMaster ? `${hostname} (Master)` : displayName);
        this._setText('server-identity-ip', `${srv.host_ip || '127.0.0.1'}:${srv.agent_port || (isMaster ? 3500 : 3501)}`);
        this._setText('server-identity-os', srv.os_info || snap.os_info || 'Linux');
        this._setText('header-hostname', hostname);

        const hostCtrlLbl = document.getElementById('host-ctrl-target-label');
        if (hostCtrlLbl) hostCtrlLbl.textContent = `Target: ${displayName}`;

        if (window.webTerminal && typeof window.webTerminal.setServer === 'function') {
            window.webTerminal.setServer(srv.id || this.currentServerId, displayName, srv.host_ip);
        }

        const dotEl = document.getElementById('server-identity-dot');
        if (dotEl) {
            dotEl.className = `pulse-dot ${srv.status === 'online' ? 'connected' : (srv.status === 'degraded' ? 'degraded' : 'error')}`;
        }

        // CPU
        const cpuVal = snap.cpu_percent != null ? Number(snap.cpu_percent) : Number(srv.latest_cpu || 0);
        this._setText('metric-cpu-val', cpuVal.toFixed(1) + '%');
        this._setText('sys-cores-sub', isMaster ? 'Overall Load' : `Remote Node (${srv.host_ip})`);
        this._setWidth('metric-cpu-bar', cpuVal);
        this._setBarColor('metric-cpu-bar', cpuVal);

        // Memory
        const memPct = snap.mem_percent != null ? Number(snap.mem_percent) : Number(srv.latest_mem || 0);
        this._setText('metric-mem-val', memPct.toFixed(1) + '%');
        this._setText('metric-mem-sub', `${memPct.toFixed(1)}% Allocated`);
        this._setWidth('metric-mem-bar', memPct);

        // Disk
        const diskPct = snap.disk_percent != null ? Number(snap.disk_percent) : Number(srv.latest_disk || 0);
        this._setText('metric-disk-val', diskPct.toFixed(1) + '%');
        this._setText('metric-disk-sub', `/ (Root Partition)`);
        this._setWidth('metric-disk-bar', diskPct);

        // Network
        const rxKB = ((Number(snap.net_rx_sec) || 0) / 1024).toFixed(1);
        const txKB = ((Number(snap.net_tx_sec) || 0) / 1024).toFixed(1);
        this._setText('metric-net-val', `${rxKB} KB/s`);
        this._setText('metric-net-sub', `↓ ${rxKB} KB/s  ↑ ${txKB} KB/s`);

        // System Specs
        const osInfo = srv.os_info || snap.os_info || 'Linux';
        const arch = srv.arch || snap.arch || 'x86_64';
        const uptimeSec = Number(snap.uptime != null ? snap.uptime : (srv.latest_uptime || 0));
        const loadAvg1 = snap.load_avg_1 != null ? Number(snap.load_avg_1).toFixed(2) : (srv.latest_load != null ? Number(srv.latest_load).toFixed(2) : '--');

        this._setText('sys-os', osInfo);
        this._setText('sys-kernel', `${osInfo} (${arch})`);
        this._setText('sys-arch', arch);
        this._setText('sys-cores', isMaster ? '--' : `Agent Host (${srv.host_ip}:${srv.agent_port || 3501})`);
        this._setText('sys-uptime', this._fmtUptime(uptimeSec));
        this._setText('sys-load', `${loadAvg1}`);

        // Storage Volume List
        const diskContainer = document.getElementById('disk-mounts-list');
        if (diskContainer) {
            const color = diskPct > 90 ? '#ef4444' : diskPct > 75 ? '#f59e0b' : 'var(--accent-amber)';
            diskContainer.innerHTML = `
            <div style="margin-bottom:1rem;">
                <div style="display:flex;justify-content:space-between;margin-bottom:0.25rem;">
                    <span style="font-family:var(--font-mono);font-size:0.8rem;color:var(--text-muted);">/dev/root</span>
                    <span style="font-size:0.8rem;color:var(--text-dim);">/ (Root Filesystem)</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width:${diskPct}%;background:linear-gradient(90deg,${color},${color}99);"></div>
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:0.2rem;font-size:0.75rem;color:var(--text-dim);">
                    <span>${diskPct.toFixed(1)}% Used</span>
                    <span>Status: ${srv.status || 'Active'}</span>
                </div>
            </div>`;
        }

        // Charts
        if (this.cpuChart) this.cpuChart.addPoint(cpuVal);
        if (this.memChart) this.memChart.addPoint(memPct);
        if (this.netChart) this.netChart.addPoint(parseFloat(rxKB), parseFloat(txKB));
    }

    async updateSidebarServers(serversList) {
        const container = document.getElementById('sidebar-servers-list');
        const countEl   = document.getElementById('sidebar-server-count');
        if (!container) return;

        let servers = serversList;
        if (!servers) {
            try {
                const resp = await PulseOpsAuth.apiFetch('/api/fleet/servers');
                if (resp && resp.ok) servers = await resp.json();
            } catch (e) {
                console.warn('[App] Could not fetch servers for sidebar:', e);
            }
        }
        if (!servers || !Array.isArray(servers)) return;

        if (countEl) countEl.textContent = servers.length;

        container.innerHTML = servers.map(srv => {
            const isMaster = srv.id === 'local-master';
            const displayName = srv.display_name || srv.hostname || (isMaster ? 'Master Node' : 'Server');
            const isActive = this.currentServerId === srv.id;
            const statusCls = srv.status || 'offline';
            return `
            <button class="sidebar-btn sidebar-server-item ${isActive ? 'active' : ''}" 
                    data-server-id="${srv.id}" 
                    data-hostname="${srv.hostname || displayName}" 
                    data-ip="${srv.host_ip || ''}"
                    data-port="${srv.agent_port || (isMaster ? 3500 : 3501)}"
                    data-os="${srv.os_info || ''}"
                    title="${displayName} (${srv.host_ip})">
                <span class="sidebar-server-dot ${statusCls}"></span>
                <span class="sidebar-label server-item-text">
                    <span class="server-item-name">
                        ${displayName}
                        ${isMaster ? '<span class="master-tag">Master</span>' : ''}
                    </span>
                    <span class="server-item-ip">${srv.host_ip}</span>
                </span>
            </button>`;
        }).join('');

        // Attach click listeners
        container.querySelectorAll('.sidebar-server-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const sId = btn.dataset.serverId;
                const hName = btn.dataset.hostname;
                this.selectServer(sId, hName);
            });
        });
    }

    // ── WebSocket Telemetry ───────────────────────────────────────────────────

    connectWebSocket() {
        if (this.ws && this.ws.readyState <= 1) return; // Already open/connecting

        const proto   = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl   = `${proto}//${window.location.host}/`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this._setConnectionStatus('connected');
            this.wsReconnectDelay = 2000;
            if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        };

        this.ws.onclose = () => {
            this._setConnectionStatus('disconnected');
            this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), this.wsReconnectDelay);
            this.wsReconnectDelay = Math.min(30000, this.wsReconnectDelay * 1.5);
        };

        this.ws.onerror = () => this._setConnectionStatus('error');

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'telemetry')   this.handleTelemetry(msg.data);
                if (msg.type === 'logStream')   this.handleLogStream(msg.data);
                if (msg.type === 'fleetUpdate') this._handleFleetUpdate(msg);
                if (msg.type === 'alert_fired') AlertsManager?.handleAlertEvent(msg);
            } catch (e) {
                console.warn('[WS] Parse error:', e);
            }
        };
    }

    _setConnectionStatus(state) {
        const dot  = document.getElementById('connection-dot');
        const text = document.getElementById('connection-text');
        if (!dot || !text) return;

        const states = {
            connected:    { cls: 'connected',    label: 'LIVE' },
            disconnected: { cls: 'disconnected', label: 'RECONNECTING' },
            error:        { cls: 'error',        label: 'ERROR' },
        };
        const s = states[state] || states.disconnected;
        dot.className  = `pulse-dot ${s.cls}`;
        text.textContent = s.label;
    }

    _handleFleetUpdate(msg) {
        if (typeof FleetManager !== 'undefined') FleetManager.handleFleetUpdate(msg);
        if (typeof AlertsManager !== 'undefined') AlertsManager.updateBell();

        // If this update belongs to currently selected remote server, update live metrics
        if (this.currentServerId === msg.server_id && msg.snapshot) {
            this.renderServerData({
                id: msg.server_id,
                hostname: msg.hostname,
                display_name: msg.display_name,
                host_ip: msg.host_ip,
                agent_port: msg.agent_port,
                os_info: msg.os_info,
                status: msg.status,
                latest_snapshot: msg.snapshot,
            });
        }
        // Update status dot in sidebar
        const item = document.querySelector(`.sidebar-server-item[data-server-id="${msg.server_id}"]`);
        if (item) {
            const dot = item.querySelector('.sidebar-server-dot');
            if (dot) dot.className = `sidebar-server-dot ${msg.status}`;
        }
    }

    // ── Telemetry Data Handler ────────────────────────────────────────────────

    handleTelemetry(data) {
        // Only process master WebSocket telemetry if we are viewing master node
        if (this.currentServerId && this.currentServerId !== 'local-master') {
            return;
        }

        // CPU
        const cpuVal = data.cpu || 0;
        this._setText('metric-cpu-val', cpuVal.toFixed(1) + '%');
        this._setWidth('metric-cpu-bar', cpuVal);
        this._setBarColor('metric-cpu-bar', cpuVal);

        // Memory
        const mem    = data.memory || {};
        const memPct = mem.usagePercent || 0;
        const memUsed  = this._fmtBytes(mem.used  || 0);
        const memTotal = this._fmtBytes(mem.total || 0);
        this._setText('metric-mem-val', memPct.toFixed(1) + '%');
        this._setText('metric-mem-sub', `${memUsed} / ${memTotal}`);
        this._setWidth('metric-mem-bar', memPct);

        // Disk
        const disks = data.disks || [];
        const root  = disks.find(d => d.mount === '/') || disks[0] || {};
        const diskPct   = root.usagePercent || 0;
        const diskUsed  = this._fmtBytes(root.used  || 0);
        const diskTotal = this._fmtBytes(root.total || 0);
        this._setText('metric-disk-val', diskPct.toFixed(1) + '%');
        this._setText('metric-disk-sub', `${diskUsed} / ${diskTotal}`);
        this._setWidth('metric-disk-bar', diskPct);

        // Network
        const net    = data.network || {};
        const rxKB   = ((net.rxSec || 0) / 1024).toFixed(1);
        const txKB   = ((net.txSec || 0) / 1024).toFixed(1);
        this._setText('metric-net-val', `${rxKB} KB/s`);
        this._setText('metric-net-sub', `↓ ${rxKB} KB/s  ↑ ${txKB} KB/s`);

        // System info
        const sys = data.sysInfo || {};
        this._setText('sys-os',     sys.osName  || '--');
        this._setText('sys-kernel', sys.kernel  || '--');
        this._setText('sys-arch',   sys.arch    || '--');
        this._setText('sys-cores',  `${sys.cpuModel || 'Unknown'} (${sys.coreCount || 0} cores)`);
        this._setText('sys-cores-sub', `${sys.coreCount || 0} Cores`);
        this._setText('sys-uptime', this._fmtUptime(sys.uptime || 0));
        this._setText('header-hostname', sys.hostname || 'localhost');
        this._setText('sys-load',   (sys.loadAvg || [0,0,0]).map(l => l.toFixed(2)).join('  '));

        // Identity bar update for Master
        const idHost = document.getElementById('server-identity-hostname');
        const idIp   = document.getElementById('server-identity-ip');
        const idDot  = document.getElementById('server-identity-dot');
        const idOs   = document.getElementById('server-identity-os');
        if (idHost) idHost.textContent = (sys.hostname || 'mail.sword.local') + ' (Master)';
        if (idIp) idIp.textContent = window.location.host;
        if (idDot) idDot.className = 'pulse-dot connected';
        if (idOs) idOs.textContent = sys.osName || 'Linux';

        // Disk list
        this._renderDiskList(disks);

        // Charts
        if (this.cpuChart) this.cpuChart.addPoint(cpuVal);
        if (this.memChart) this.memChart.addPoint(memPct);
        if (this.netChart) this.netChart.addPoint(parseFloat(rxKB), parseFloat(txKB));

        // Alert checks
        if (cpuVal > this.alertThresholds.cpu) {
            showToast(`⚠️ High CPU: ${cpuVal.toFixed(1)}%`, 'warning', 8000);
        }
    }

    _setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    _setWidth(id, pct) {
        const el = document.getElementById(id);
        if (el) el.style.width = Math.min(100, Math.max(0, pct)) + '%';
    }

    _setBarColor(id, pct) {
        const el = document.getElementById(id);
        if (!el) return;
        if (pct > 90) el.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)';
        else if (pct > 75) el.style.background = 'linear-gradient(90deg, #f59e0b, #d97706)';
        else el.style.background = 'linear-gradient(90deg, var(--accent-cyan), var(--accent-blue))';
    }

    _renderDiskList(disks) {
        const container = document.getElementById('disk-mounts-list');
        if (!container) return;
        if (!disks || disks.length === 0) {
            container.innerHTML = '<div style="color:var(--text-dim);">No disk data</div>';
            return;
        }
        container.innerHTML = disks.map(d => {
            const usedStr  = this._fmtBytes(d.used  || 0);
            const totalStr = this._fmtBytes(d.total || 0);
            const pct = d.usagePercent || 0;
            const color = pct > 90 ? '#ef4444' : pct > 75 ? '#f59e0b' : 'var(--accent-amber)';
            return `
            <div style="margin-bottom:1rem;">
                <div style="display:flex;justify-content:space-between;margin-bottom:0.25rem;">
                    <span style="font-family:var(--font-mono);font-size:0.8rem;color:var(--text-muted);">${d.fs}</span>
                    <span style="font-size:0.8rem;color:var(--text-dim);">${d.mount}</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width:${pct}%;background:linear-gradient(90deg,${color},${color}99);"></div>
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:0.2rem;font-size:0.75rem;color:var(--text-dim);">
                    <span>${usedStr} used</span>
                    <span>${totalStr} total (${pct.toFixed(0)}%)</span>
                </div>
            </div>`;
        }).join('');
    }

    _fmtBytes(bytes) {
        if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(1) + ' TB';
        if (bytes >= 1073741824)    return (bytes / 1073741824).toFixed(1)    + ' GB';
        if (bytes >= 1048576)       return (bytes / 1048576).toFixed(1)       + ' MB';
        if (bytes >= 1024)          return (bytes / 1024).toFixed(1)          + ' KB';
        return bytes + ' B';
    }

    _fmtUptime(seconds) {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return `${d}d ${h}h ${m}m`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    // ── Log Stream Handler ────────────────────────────────────────────────────

    handleLogStream(log) {
        if (window.logStreamMgr) window.logStreamMgr.appendLog(log);
    }

    // ── Charts ────────────────────────────────────────────────────────────────

    initCharts() {
        if (typeof PulseChartManager !== 'undefined') {
            this.cpuChart = new PulseChartManager('cpu-chart',  { color: '#38bdf8', label: 'CPU %'         });
            this.memChart = new PulseChartManager('mem-chart',  { color: '#a855f7', label: 'MEM %'         });
            this.netChart = new PulseChartManager('net-chart',  { color: '#22c55e', label: 'NET RX KB/s', dual: true });
        }
    }

    // ── Toast System ──────────────────────────────────────────────────────────

    initToastSystem() {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
    }

    // ── Universal Modal System ────────────────────────────────────────────────

    initModalSystem() {
        document.addEventListener('click', (e) => {
            // Open modal triggered by [data-open-modal]
            const openBtn = e.target.closest('[data-open-modal]');
            if (openBtn) {
                e.preventDefault();
                const modalId = openBtn.getAttribute('data-open-modal');
                const modal = document.getElementById(modalId);
                if (modal) {
                    modal.classList.add('active');
                    modal.style.display = 'flex';
                    const firstInput = modal.querySelector('input:not([type="hidden"]), select');
                    if (firstInput) setTimeout(() => firstInput.focus(), 60);
                }
                return;
            }

            // Close modal triggered by [data-close-modal]
            const closeBtn = e.target.closest('[data-close-modal]');
            if (closeBtn) {
                e.preventDefault();
                const modalId = closeBtn.getAttribute('data-close-modal');
                const modal = modalId ? document.getElementById(modalId) : closeBtn.closest('.modal-overlay');
                if (modal) {
                    modal.classList.remove('active');
                    modal.style.display = 'none';
                }
                return;
            }

            // Close button with class .modal-close
            const modalClose = e.target.closest('.modal-close');
            if (modalClose && !modalClose.hasAttribute('data-close-modal')) {
                e.preventDefault();
                const modal = modalClose.closest('.modal-overlay');
                if (modal) {
                    modal.classList.remove('active');
                    modal.style.display = 'none';
                }
                return;
            }

            // Backdrop click on overlay itself
            if (e.target.classList && e.target.classList.contains('modal-overlay')) {
                e.target.classList.remove('active');
                e.target.style.display = 'none';
            }
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay').forEach(modal => {
                    modal.classList.remove('active');
                    modal.style.display = 'none';
                });
            }
        });
    }

    async quickSystemAction(action) {
        if (window.PulseOpsAuth && !window.PulseOpsAuth.isOperator()) {
            window.showToast && window.showToast('Permission denied: Viewer accounts cannot perform host operations', 'error');
            return;
        }
        const sId = this.currentServerId || 'local-master';
        const hostname = window.PulseOpsCurrentServerHostname || (sId === 'local-master' ? 'mail.sword.local' : 'Remote Node');

        let cmd = '';
        let confirmMsg = '';
        let successMsg = '';

        if (action === 'drop_caches') {
            cmd = 'sync; echo 3 > /proc/sys/vm/drop_caches && free -h';
            confirmMsg = `Drop OS filesystem page cache to reclaim unused RAM on ${hostname}?`;
            successMsg = `RAM page cache purged successfully on ${hostname}.`;
        } else if (action === 'check_updates') {
            cmd = 'apt-get update 2>&1 | tail -n 12 || dnf check-update 2>&1 | tail -n 12';
            confirmMsg = `Check for available system package updates on ${hostname}?`;
            successMsg = `Package update check completed on ${hostname}.`;
        } else if (action === 'failed_services') {
            const svcTabBtn = document.querySelector('#section-server-dashboard .nav-tabs .tab-btn[data-tab="services"]');
            if (svcTabBtn) {
                svcTabBtn.click();
                const failedFilterBtn = document.querySelector('#services-tab .btn-filter[data-filter="failed"]');
                if (failedFilterBtn) failedFilterBtn.click();
            }
            return;
        } else if (action === 'restart_agent') {
            cmd = sId === 'local-master' ? 'systemctl restart pulseops' : 'systemctl restart pulseops-agent';
            confirmMsg = `Restart PulseOps monitoring service daemon on ${hostname}?`;
            successMsg = `Service restart command dispatched to ${hostname}.`;
        } else if (action === 'reboot') {
            cmd = 'reboot';
            confirmMsg = `⚠️ CRITICAL: Are you sure you want to REBOOT ${hostname} (${sId})?\n\nThis will temporarily disconnect all services running on this machine!`;
            successMsg = `Reboot command sent to ${hostname}. Host is restarting...`;
        } else {
            return;
        }

        if (confirmMsg && !confirm(confirmMsg)) return;

        window.showToast && window.showToast(`Executing system action on ${hostname}...`, 'info');

        try {
            const authFetch = (window.PulseOpsAuth && PulseOpsAuth.apiFetch) ? PulseOpsAuth.apiFetch : fetch;
            const res = await authFetch('/api/terminal/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd, server_id: sId })
            });
            const data = await res.json();
            if (data.success) {
                window.showToast && window.showToast(successMsg, 'success', 6000);
                if (action === 'drop_caches') {
                    if (sId === 'local-master') {
                        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping' }));
                    } else {
                        this.loadServerData(sId);
                    }
                }
            } else {
                window.showToast && window.showToast(data.error || data.stderr || 'Action failed', 'error');
            }
        } catch (e) {
            window.showToast && window.showToast('Network error executing system action', 'error');
        }
    }
}

/* ─── Bootstrap ──────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    window.pulseDash = new PulseOpsDashboard();
    window.pulseDash.init().catch(console.error);
});

// Also listen for auth ready event (in case DOMContentLoaded already fired)
document.addEventListener('pulseops:auth:ready', (e) => {
    if (!window.pulseDash) {
        window.pulseDash = new PulseOpsDashboard();
        window.pulseDash.init().catch(console.error);
    }
});
