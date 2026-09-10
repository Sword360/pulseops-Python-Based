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
    }

    // ── Boot Sequence ─────────────────────────────────────────────────────────

    async init() {
        // Wait for auth to complete
        this.currentUser = await PulseOpsAuth.requireAuth();
        if (!this.currentUser) return; // Redirected to login

        this.applyUserContext();
        this.initSidebar();
        this.initTabs();
        this.initCharts();
        this.initToastSystem();
        this.initUserMenu();
        this.initTheme();
        this.connectWebSocket();
        this.initModules();
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

        // Role-based visibility
        const isAdmin    = user.role === 'admin';
        const isOperator = ['admin', 'operator'].includes(user.role);

        document.querySelectorAll('.admin-only').forEach(el => {
            el.style.display = isAdmin ? '' : 'none';
        });
        document.querySelectorAll('.operator-only').forEach(el => {
            el.style.display = isOperator ? '' : 'none';
        });

        // Show sidebar server btn only when a server is selected
        const serverSidebarBtn = document.getElementById('sidebar-server-btn');
        if (serverSidebarBtn) serverSidebarBtn.style.display = 'none';
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
                container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                container.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const target = document.getElementById(`${btn.dataset.tab}-tab`);
                if (target) target.classList.add('active');

                // Lazy-load tab data
                if (btn.dataset.tab === 'services'  && window.systemdMgr) window.systemdMgr.loadServices();
                if (btn.dataset.tab === 'processes' && window.procMgr)    window.procMgr.loadProcesses();
                if (btn.dataset.tab === 'vnc'       && window.vncMgr)     window.vncMgr.checkHostVncStatus();
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
        document.documentElement.setAttribute('data-theme', saved);
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

    _onServerSelected({ serverId, hostname }) {
        // Show server-specific sidebar button
        const serverBtn  = document.getElementById('sidebar-server-btn');
        const serverLabel = document.getElementById('sidebar-server-label');
        if (serverBtn) {
            serverBtn.style.display = '';
            serverBtn.classList.add('active');
            document.querySelectorAll('.sidebar-btn').forEach(b => {
                if (b !== serverBtn) b.classList.remove('active');
            });
        }
        if (serverLabel) serverLabel.textContent = hostname;

        // Update server identity bar
        const dotEl       = document.getElementById('server-identity-dot');
        const hostnameEl  = document.getElementById('server-identity-hostname');
        const ipEl        = document.getElementById('server-identity-ip');
        if (hostnameEl) hostnameEl.textContent = hostname;

        // Update header
        const headerHostname = document.getElementById('header-hostname');
        if (headerHostname) headerHostname.textContent = hostname;

        // Reconnect WebSocket if needed for live telemetry
        this.connectWebSocket();
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
        // Update sidebar alert badge
        if (typeof AlertsManager !== 'undefined') AlertsManager.updateBell();
    }

    // ── Telemetry Data Handler ────────────────────────────────────────────────

    handleTelemetry(data) {
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

        // Disk list
        this._renderDiskList(disks);

        // Charts
        if (this.cpuChart) this.cpuChart.addPoint(cpuVal);
        if (this.memChart) this.memChart.addPoint(memPct);
        if (this.netChart) this.netChart.addPoint(net.rxSec || 0, net.txSec || 0);

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
        // Toast CSS is in style.css; this ensures container exists
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            document.body.appendChild(container);
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
