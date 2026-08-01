/* ==========================================================================
   PulseOps - Core Dashboard Orchestrator
   ========================================================================== */

class PulseOpsDashboard {
    constructor() {
        this.ws = null;
        this.cpuChart = null;
        this.memChart = null;
        this.netChart = null;

        this.alertThresholds = {
            cpu: 85,
            memory: 90
        };

        this.initTabs();
        this.initCharts();
        this.initWebSocket();
        this.initToastSystem();
    }

    initTabs() {
        const tabBtns = document.querySelectorAll('.nav-tabs .tab-btn');
        const tabContents = document.querySelectorAll('.tab-content');

        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;

                tabBtns.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));

                btn.classList.add('active');
                const targetContent = document.getElementById(`${targetTab}-tab`);
                if (targetContent) {
                    targetContent.classList.add('active');
                }

                // Lazy load tab data
                if (targetTab === 'services' && window.systemdMgr) {
                    window.systemdMgr.loadServices();
                } else if (targetTab === 'processes' && window.procMgr) {
                    window.procMgr.loadProcesses();
                } else if (targetTab === 'vnc' && window.vncMgr) {
                    window.vncMgr.checkHostVncStatus();
                }
            });
        });
    }

    initCharts() {
        if (typeof SmoothLineChart !== 'undefined') {
            this.cpuChart = new SmoothLineChart('cpu-chart', {
                strokeColor: '#00f2fe',
                fillColor: 'rgba(0, 242, 254, 0.15)',
                unit: '%',
                maxY: 100
            });

            this.memChart = new SmoothLineChart('mem-chart', {
                strokeColor: '#8b5cf6',
                fillColor: 'rgba(139, 92, 246, 0.15)',
                unit: '%',
                maxY: 100
            });
        }

        if (typeof DualLineChart !== 'undefined') {
            this.netChart = new DualLineChart('net-chart');
        }
    }

    initWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;

        const connect = () => {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                this.updateStatus(true);
            };

            this.ws.onmessage = (evt) => {
                try {
                    const msg = JSON.parse(evt.data);
                    if (msg.type === 'telemetry') {
                        this.updateTelemetry(msg.data);
                    } else if (msg.type === 'logStream' && window.logViewer) {
                        window.logViewer.pushLog(msg.data);
                    }
                } catch (e) {
                    console.error('Error parsing WS message:', e);
                }
            };

            this.ws.onclose = () => {
                this.updateStatus(false);
                // Auto reconnect after 3 seconds
                setTimeout(connect, 3000);
            };

            this.ws.onerror = () => {
                this.updateStatus(false);
            };
        };

        connect();
    }

    updateStatus(connected) {
        const dot = document.getElementById('connection-dot');
        const text = document.getElementById('connection-text');

        if (dot && text) {
            if (connected) {
                dot.classList.remove('disconnected');
                text.textContent = 'CONNECTED';
            } else {
                dot.classList.add('disconnected');
                text.textContent = 'DISCONNECTED';
            }
        }
    }

    updateTelemetry(data) {
        const { cpu, memory, disks, network, sysInfo } = data;

        // 1. CPU Metric Update
        const cpuValEl = document.getElementById('metric-cpu-val');
        const cpuBar = document.getElementById('metric-cpu-bar');
        if (cpuValEl) cpuValEl.textContent = `${cpu}%`;
        if (cpuBar) {
            cpuBar.style.width = `${cpu}%`;
            cpuBar.className = `progress-bar-fill ${cpu > 80 ? 'danger' : cpu > 60 ? 'warning' : ''}`;
        }

        if (this.cpuChart) {
            this.cpuChart.pushData(cpu);
        }

        // Check CPU Threshold Alert
        if (cpu > this.alertThresholds.cpu) {
            this.triggerAlert(`High CPU Usage Warning: ${cpu}%`, 'cpu');
        }

        // 2. Memory Metric Update
        const memValEl = document.getElementById('metric-mem-val');
        const memSubEl = document.getElementById('metric-mem-sub');
        const memBar = document.getElementById('metric-mem-bar');

        const usedGb = (memory.used / (1024 ** 3)).toFixed(1);
        const totalGb = (memory.total / (1024 ** 3)).toFixed(1);

        if (memValEl) memValEl.textContent = `${memory.usagePercent}%`;
        if (memSubEl) memSubEl.textContent = `${usedGb} GB / ${totalGb} GB`;
        if (memBar) {
            memBar.style.width = `${memory.usagePercent}%`;
            memBar.className = `progress-bar-fill ${memory.usagePercent > 85 ? 'danger' : memory.usagePercent > 70 ? 'warning' : ''}`;
        }

        if (this.memChart) {
            this.memChart.pushData(memory.usagePercent);
        }

        // 3. Network Metric Update
        const formatBytesRate = (bytesSec) => {
            if (bytesSec < 1024) return `${bytesSec.toFixed(0)} B/s`;
            if (bytesSec < 1024 * 1024) return `${(bytesSec / 1024).toFixed(1)} KB/s`;
            return `${(bytesSec / (1024 * 1024)).toFixed(2)} MB/s`;
        };

        const formatTotalBytes = (bytes) => {
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        };

        const rxRateStr = formatBytesRate(network.rxSec);
        const txRateStr = formatBytesRate(network.txSec);
        const rxTotStr = formatTotalBytes(network.totalRx || 0);
        const txTotStr = formatTotalBytes(network.totalTx || 0);

        const netValEl = document.getElementById('metric-net-val');
        const netSubEl = document.getElementById('metric-net-sub');

        if (netValEl) netValEl.textContent = rxRateStr;
        if (netSubEl) netSubEl.textContent = `↓ ${rxRateStr} (${rxTotStr})  ↑ ${txRateStr} (${txTotStr})`;

        if (this.netChart) {
            this.netChart.pushData(network.rxSec, network.txSec);
        }

        // 4. Disk Metric Update
        const mainDisk = disks[0] || { usagePercent: 0, used: 0, total: 100 };
        const diskValEl = document.getElementById('metric-disk-val');
        const diskSubEl = document.getElementById('metric-disk-sub');
        const diskBar = document.getElementById('metric-disk-bar');

        const diskUsedGb = (mainDisk.used / (1024 ** 3)).toFixed(1);
        const diskTotalGb = (mainDisk.total / (1024 ** 3)).toFixed(1);

        if (diskValEl) diskValEl.textContent = `${mainDisk.usagePercent}%`;
        if (diskSubEl) diskSubEl.textContent = `${diskUsedGb} GB / ${diskTotalGb} GB (${mainDisk.mount})`;
        if (diskBar) diskBar.style.width = `${mainDisk.usagePercent}%`;

        // Render disk list in overview
        const diskContainer = document.getElementById('disk-mounts-list');
        if (diskContainer && disks.length > 0) {
            diskContainer.innerHTML = disks.map(d => {
                const uGb = (d.used / (1024 ** 3)).toFixed(1);
                const tGb = (d.total / (1024 ** 3)).toFixed(1);
                return `
                    <div style="margin-bottom: 0.8rem;">
                        <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 4px;">
                            <span><strong style="color: var(--text-main); font-family: var(--font-mono);">${d.mount}</strong> (${d.fs})</span>
                            <span style="color: var(--text-muted);">${uGb} GB / ${tGb} GB (${d.usagePercent}%)</span>
                        </div>
                        <div class="progress-bar-bg">
                            <div class="progress-bar-fill ${d.usagePercent > 85 ? 'danger' : ''}" style="width: ${d.usagePercent}%;"></div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // 5. System Info Update
        if (sysInfo) {
            const hostBadge = document.getElementById('header-hostname');
            if (hostBadge) hostBadge.textContent = sysInfo.hostname;

            const updateText = (id, txt) => {
                const el = document.getElementById(id);
                if (el) el.textContent = txt;
            };

            updateText('sys-os', sysInfo.osName);
            updateText('sys-kernel', sysInfo.kernel);
            updateText('sys-arch', sysInfo.arch);
            updateText('sys-cores', `${sysInfo.coreCount} Cores (${sysInfo.cpuModel})`);
            updateText('sys-load', sysInfo.loadAvg ? sysInfo.loadAvg.join('  |  ') : '0.0 0.0 0.0');

            // Format uptime
            const hours = Math.floor(sysInfo.uptime / 3600);
            const mins = Math.floor((sysInfo.uptime % 3600) / 60);
            updateText('sys-uptime', `${hours}h ${mins}m`);
        }
    }

    triggerAlert(msg, type) {
        const now = Date.now();
        if (!this.lastAlertTime) this.lastAlertTime = {};
        if (this.lastAlertTime[type] && now - this.lastAlertTime[type] < 30000) return; // 30s throttle
        this.lastAlertTime[type] = now;

        window.showToast(msg, 'error');
    }

    initToastSystem() {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        window.showToast = (message, type = 'info') => {
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.innerHTML = `
                <span style="font-size: 1.1rem;">${type === 'success' ? '✓' : type === 'error' ? '⚠' : 'ℹ'}</span>
                <div>${message}</div>
            `;

            container.appendChild(toast);

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(100%)';
                toast.style.transition = 'all 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }, 4000);
        };
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.pulseOps = new PulseOpsDashboard();
});
