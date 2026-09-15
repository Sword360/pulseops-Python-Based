/* ==========================================================================
   PulseOps - Live Log Stream & Terminal Modules
   ========================================================================== */

class LogStreamViewer {
    constructor() {
        this.container = document.getElementById('log-terminal-container');
        this.filterInput = document.getElementById('log-search-filter');
        this.levelFilter = document.getElementById('log-level-filter');
        this.autoScrollBtn = document.getElementById('log-autoscroll-toggle');
        this.clearBtn = document.getElementById('log-clear-btn');

        this.autoScroll = true;
        this.logs = [];

        this.initDOM();
    }

    initDOM() {
        if (this.clearBtn) {
            this.clearBtn.addEventListener('click', () => {
                this.logs = [];
                if (this.container) this.container.innerHTML = '';
            });
        }

        if (this.autoScrollBtn) {
            this.autoScrollBtn.addEventListener('click', () => {
                this.autoScroll = !this.autoScroll;
                this.autoScrollBtn.classList.toggle('active', this.autoScroll);
                this.autoScrollBtn.textContent = this.autoScroll ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
            });
        }

        if (this.filterInput) {
            this.filterInput.addEventListener('input', () => this.render());
        }
        if (this.levelFilter) {
            this.levelFilter.addEventListener('change', () => this.render());
        }
    }

    pushLog(entry) {
        this.logs.push(entry);
        if (this.logs.length > 500) this.logs.shift(); // Keep max 500 lines

        this.appendSingleLog(entry);
    }

    appendSingleLog(entry) {
        if (!this.container) return;

        const query = this.filterInput ? this.filterInput.value.toLowerCase() : '';
        const level = this.levelFilter ? this.levelFilter.value : 'ALL';

        if (level !== 'ALL' && entry.level !== level) return;
        if (query && !entry.message.toLowerCase().includes(query) && !entry.source.toLowerCase().includes(query)) return;

        const line = document.createElement('div');
        line.className = 'log-line';

        const timeStr = new Date(entry.timestamp).toLocaleTimeString();

        line.innerHTML = `
            <span class="log-time">[${timeStr}]</span>
            <span class="log-source">${entry.source}:</span>
            <span class="log-lvl ${entry.level}">${entry.level}</span>
            <span class="log-msg">${entry.message}</span>
        `;

        this.container.appendChild(line);

        if (this.autoScroll) {
            this.container.scrollTop = this.container.scrollHeight;
        }
    }

    render() {
        if (!this.container) return;
        this.container.innerHTML = '';
        this.logs.forEach(entry => this.appendSingleLog(entry));
    }

    async loadLogs(serverId) {
        const sId = serverId || window.PulseOpsCurrentServer || 'local-master';
        const hostname = window.PulseOpsCurrentServerHostname || (sId === 'local-master' ? 'mail.sword.local' : 'node');
        const authFetch = (window.PulseOpsAuth && PulseOpsAuth.apiFetch) ? PulseOpsAuth.apiFetch : fetch;
        try {
            const res = await authFetch(`/api/logs?server_id=${encodeURIComponent(sId)}&lines=100`);
            const data = await res.json();
            if (data.token_mismatch || (res.status === 401 && sId !== 'local-master')) {
                this.pushLog({
                    timestamp: new Date().toISOString(),
                    source: 'pulseops',
                    level: 'ERROR',
                    message: `[Auth Mismatch] Agent on ${hostname} rejected authentication token. Run 'sudo systemctl restart pulseops-agent' on ${hostname} to synchronize.`
                });
                return;
            }
            if (data && data.logs && Array.isArray(data.logs)) {
                if (data.logs.length > 0) {
                    this.logs = [];
                    if (this.container) this.container.innerHTML = '';
                }
                data.logs.forEach(entry => {
                    if (typeof entry === 'string') {
                        let lvl = 'INFO';
                        const low = entry.toLowerCase();
                        if (low.includes('error') || low.includes('fail') || low.includes('crit')) lvl = 'ERROR';
                        else if (low.includes('warn')) lvl = 'WARN';
                        else if (low.includes('debug')) lvl = 'DEBUG';
                        this.pushLog({
                            timestamp: new Date().toISOString(),
                            source: 'journal',
                            level: lvl,
                            message: entry
                        });
                    } else if (entry && entry.line) {
                        let lvl = 'INFO';
                        const low = entry.line.toLowerCase();
                        if (low.includes('error') || low.includes('fail') || low.includes('crit')) lvl = 'ERROR';
                        else if (low.includes('warn')) lvl = 'WARN';
                        else if (low.includes('debug')) lvl = 'DEBUG';
                        this.pushLog({
                            timestamp: entry.time || new Date().toISOString(),
                            source: 'journal',
                            level: lvl,
                            message: entry.line
                        });
                    } else if (entry) {
                        this.pushLog(entry);
                    }
                });
            }
        } catch (e) {
            console.error('Failed to fetch logs:', e);
        }
    }
}

class WebTerminal {
    constructor() {
        this.window = document.querySelector('.terminal-window');
        this.body = document.getElementById('terminal-body');
        this.input = document.getElementById('terminal-input');
        this.prompt = document.getElementById('term-prompt');
        this.history = [];
        this.historyIndex = -1;
        this.savedCurrentInput = '';
        this.sudoPassword = '';
        this.pendingSudoCmd = null;
        this.serverId = 'local-master';
        this.hostname = 'mail.sword.local';
        this.hostIp = '127.0.0.1';
        this.cwd = '~';
        this.isFullscreen = false;

        this.initDOM();
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    ansiToHtml(str) {
        if (!str) return '';
        let escaped = this.escapeHtml(str);
        const colorMap = {
            '30': '#1e293b', '31': '#ef4444', '32': '#10b981', '33': '#f59e0b',
            '34': '#38bdf8', '35': '#d946ef', '36': '#00f2fe', '37': '#f8fafc',
            '90': '#64748b', '91': '#f87171', '92': '#34d399', '93': '#fde047',
            '94': '#60a5fa', '95': '#e879f9', '96': '#22d3ee', '97': '#ffffff'
        };

        // Strip non-color CSI sequences (note: 'm' is excluded from pattern so SGR codes match next)
        escaped = escaped.replace(/\u001b\[[0-9;]*[A-HJKSTfnsu]/g, '');
        escaped = escaped.replace(/\u001b\([AB012]/g, '');

        let openSpans = 0;
        const converted = escaped.replace(/\u001b\[([0-9;]*)m/g, (match, codeStr) => {
            if (!codeStr || codeStr === '0') {
                let res = '</span>'.repeat(openSpans);
                openSpans = 0;
                return res;
            }
            const codes = codeStr.split(';');
            let styles = [];
            codes.forEach(c => {
                if (c === '1') styles.push('font-weight:bold');
                else if (c === '2') styles.push('opacity:0.7');
                else if (c === '4') styles.push('text-decoration:underline');
                else if (colorMap[c]) styles.push('color:' + colorMap[c]);
            });
            if (styles.length > 0) {
                openSpans++;
                return `<span style="${styles.join(';')}">`;
            }
            return '';
        });
        return converted + '</span>'.repeat(openSpans);
    }

    scrollToBottom() {
        if (!this.body) return;
        this.body.scrollTop = this.body.scrollHeight;
        requestAnimationFrame(() => {
            if (this.body) this.body.scrollTop = this.body.scrollHeight;
        });
    }

    initDOM() {
        // Focus input when clicking anywhere inside terminal window (unless selecting text)
        if (this.window) {
            this.window.addEventListener('click', (e) => {
                if (window.getSelection && window.getSelection().toString().length > 0) return;
                if (e.target.closest('button') || e.target.closest('input')) return;
                if (this.input && !this.input.disabled) {
                    this.input.focus();
                }
            });
        }

        // Terminal input keyboard shortcuts
        if (this.input) {
            this.input.addEventListener('keydown', (e) => {
                // Ctrl+L: Clear screen
                if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
                    e.preventDefault();
                    this.clearScreen();
                    return;
                }

                // Ctrl+C: Cancel current line or sudo prompt
                if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
                    e.preventDefault();
                    if (this.pendingSudoCmd) {
                        this.pendingSudoCmd = null;
                        this.resetInputMode();
                        this.appendTerminalMessage('[sudo] password prompt cancelled (^C)', 'var(--text-dim)');
                        return;
                    }
                    const val = this.input.value;
                    this.input.value = '';
                    const promptText = this.getTerminalPrompt();
                    const cmdLine = document.createElement('div');
                    cmdLine.className = 'term-output';
                    cmdLine.innerHTML = `<span style="color: var(--accent-green); font-weight:700;">${this.escapeHtml(promptText)}</span> <span style="color:var(--text-dim);">${this.escapeHtml(val)}^C</span>`;
                    this.body.appendChild(cmdLine);
                    this.scrollToBottom();
                    return;
                }

                // Escape: Cancel sudo prompt
                if (e.key === 'Escape' && this.pendingSudoCmd) {
                    e.preventDefault();
                    this.pendingSudoCmd = null;
                    this.resetInputMode();
                    this.appendTerminalMessage('[sudo] password prompt cancelled (ESC)', 'var(--text-dim)');
                    return;
                }

                if (e.key === 'Enter') {
                    if (this.pendingSudoCmd) {
                        const pass = this.input.value;
                        this.sudoPassword = pass;
                        const targetCmd = this.pendingSudoCmd;
                        this.pendingSudoCmd = null;
                        this.resetInputMode();
                        this.executeCommand(targetCmd);
                        return;
                    }

                    const val = this.input.value.trim();
                    if (val) {
                        this.history.push(val);
                        this.historyIndex = this.history.length;
                        this.savedCurrentInput = '';
                        this.input.value = '';
                        this.executeCommand(val);
                    }
                } else if (e.key === 'ArrowUp' && !this.pendingSudoCmd) {
                    e.preventDefault();
                    if (this.history.length === 0) return;
                    if (this.historyIndex === this.history.length) {
                        this.savedCurrentInput = this.input.value;
                    }
                    if (this.historyIndex > 0) {
                        this.historyIndex--;
                        this.input.value = this.history[this.historyIndex];
                    }
                } else if (e.key === 'ArrowDown' && !this.pendingSudoCmd) {
                    e.preventDefault();
                    if (this.historyIndex < this.history.length - 1) {
                        this.historyIndex++;
                        this.input.value = this.history[this.historyIndex];
                    } else if (this.historyIndex === this.history.length - 1) {
                        this.historyIndex = this.history.length;
                        this.input.value = this.savedCurrentInput || '';
                    }
                }
            });
        }

        // Preset command buttons
        document.querySelectorAll('.btn-preset').forEach(btn => {
            const ignored = ['btn-sudo-auth', 'btn-term-clear', 'btn-term-copy', 'btn-term-fullscreen', 'btn-preset-reboot', 'btn-term-runbooks'];
            if (ignored.includes(btn.id)) return;
            btn.addEventListener('click', () => {
                const cmd = btn.dataset.cmd;
                if (cmd && this.input && !this.pendingSudoCmd) {
                    this.history.push(cmd);
                    this.historyIndex = this.history.length;
                    this.input.value = '';
                    this.executeCommand(cmd);
                }
            });
        });

        // Reboot Preset Button
        const rebootBtn = document.getElementById('btn-preset-reboot');
        if (rebootBtn) {
            rebootBtn.addEventListener('click', () => {
                const hName = this.hostname || 'this server';
                if (confirm(`⚠️ CRITICAL: Are you sure you want to REBOOT ${hName}?\n\nThis will execute the 'reboot' command directly on the host.`)) {
                    this.executeCommand('reboot');
                }
            });
        }

        // Clear button
        const clearBtn = document.getElementById('btn-term-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearScreen());
        }

        // Copy button
        const copyBtn = document.getElementById('btn-term-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                if (this.body) {
                    const text = this.body.innerText || this.body.textContent;
                    window.copyToClipboard(text, 'Terminal buffer copied to clipboard!');
                }
            });
        }

        // Fullscreen toggle button
        const fsBtn = document.getElementById('btn-term-fullscreen');
        if (fsBtn) {
            fsBtn.addEventListener('click', () => this.toggleFullscreen());
        }

        // Sudo Auth Button
        const sudoBtn = document.getElementById('btn-sudo-auth');
        if (sudoBtn) {
            sudoBtn.addEventListener('click', () => {
                const currentStatus = this.sudoPassword ? 'Set (Cached)' : 'Not set';
                const pass = prompt(`Configure Sudo Password for Terminal (Status: ${currentStatus})\nLeave empty and click OK to clear cached password:`, this.sudoPassword || '');
                if (pass !== null) {
                    this.sudoPassword = pass.trim();
                    if (this.sudoPassword) {
                        this.appendTerminalMessage(`[sudo] Sudo credentials updated for this web terminal session.`, '#eab308');
                    } else {
                        this.appendTerminalMessage(`[sudo] Cached sudo credentials cleared.`, 'var(--text-dim)');
                    }
                }
            });
        }

        // Initialize server context
        const sId = window.PulseOpsCurrentServer || 'local-master';
        const hName = window.PulseOpsCurrentServerHostname || 'mail.sword.local';
        this.setServer(sId, hName);
    }

    toggleFullscreen() {
        if (!this.window) return;
        this.isFullscreen = !this.isFullscreen;
        this.window.classList.toggle('is-fullscreen', this.isFullscreen);
        const fsBtn = document.getElementById('btn-term-fullscreen');
        if (fsBtn) {
            fsBtn.textContent = this.isFullscreen ? '✕ Collapse' : '⛶ Expand';
            fsBtn.style.color = this.isFullscreen ? 'var(--accent-cyan)' : '';
        }
        this.scrollToBottom();
        if (this.input) setTimeout(() => this.input.focus(), 60);
    }

    clearScreen() {
        if (!this.body) return;
        this.body.innerHTML = `
            <div class="term-output" style="color:var(--accent-cyan); font-weight:600;">⚡ PulseOps Enterprise Full-System Terminal Console v2.1</div>
            <div class="term-output" style="color:var(--text-dim); font-size:0.82rem;">Connected host: ${this.escapeHtml(this.hostname)} (${this.escapeHtml(this.hostIp || '127.0.0.1')}) [cwd: ${this.escapeHtml(this.cwd || '~')}]</div>
        `;
        this.scrollToBottom();
    }

    setServer(serverId, hostname, hostIp) {
        const targetId = serverId || window.PulseOpsCurrentServer || 'local-master';
        const isMaster = !targetId || targetId === 'local-master';
        const targetHost = hostname || window.PulseOpsCurrentServerHostname || (isMaster ? 'mail.sword.local' : 'node');
        const targetIp = hostIp || (isMaster ? '127.0.0.1' : (this.hostIp || ''));

        const serverChanged = (this.serverId !== targetId || this.hostname !== targetHost);
        this.serverId = targetId;
        this.hostname = targetHost;
        if (targetIp) this.hostIp = targetIp;

        const targetBadge = document.getElementById('term-target-badge');
        if (targetBadge) {
            targetBadge.textContent = isMaster ? 'Target: Master Node' : `Target: ${this.hostname}`;
        }
        const hostDisplay = document.getElementById('term-host-display');
        if (hostDisplay) {
            hostDisplay.textContent = `${this.hostname} (${this.hostIp || (isMaster ? '127.0.0.1:3500' : '3501')})`;
        }
        const statusPill = document.getElementById('term-status-pill');
        if (statusPill) {
            statusPill.innerHTML = `<span style="display:inline-block; width:6px; height:6px; background:#10b981; border-radius:50%;"></span> READY`;
        }

        if (serverChanged) {
            this.cwd = '~';
            this.resetInputMode(false);
        } else {
            this.updatePromptOnly();
        }
    }

    updatePromptOnly() {
        if (this.pendingSudoCmd) return;
        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;
        if (!isOperator) {
            if (this.prompt) {
                this.prompt.style.color = 'var(--text-dim)';
                this.prompt.textContent = `[viewer@${this.hostname}:ro]$`;
            }
            if (this.input && !this.input.disabled) {
                this.input.disabled = true;
                this.input.placeholder = 'Read-only mode: Viewers cannot execute commands in terminal';
            }
            return;
        }

        if (this.prompt) {
            this.prompt.style.color = '';
            this.prompt.textContent = this.getTerminalPrompt();
        }
        if (this.input && this.input.disabled) {
            this.input.disabled = false;
            this.input.placeholder = `Type a command on ${this.hostname} and press Enter...`;
        }
    }

    onTabActivated() {
        const currentSId = window.PulseOpsCurrentServer || (window.PulseOpsApp ? window.PulseOpsApp.currentServerId : this.serverId);
        const currentHName = window.PulseOpsCurrentServerHostname || this.hostname;
        if (currentSId && (currentSId !== this.serverId || currentHName !== this.hostname)) {
            this.setServer(currentSId, currentHName);
        } else {
            this.updatePromptOnly();
        }
        if (this.input && document.activeElement !== this.input) {
            setTimeout(() => {
                if (this.input && document.activeElement !== this.input) this.input.focus();
            }, 60);
        }
    }

    setSudoPasswordPromptMode(cmd, isRetry = false) {
        this.pendingSudoCmd = cmd;
        if (this.prompt) {
            this.prompt.style.color = '#eab308';
            this.prompt.textContent = '[sudo] password for pulseops: ';
        }
        if (this.input) {
            this.input.type = 'password';
            this.input.value = '';
            this.input.placeholder = isRetry ? 'Incorrect password. Re-enter sudo password...' : 'Enter sudo password...';
            this.input.focus();
        }
    }

    getTerminalPrompt() {
        const sId = window.PulseOpsCurrentServer || this.serverId || 'local-master';
        const isMaster = !sId || sId === 'local-master';
        const hostname = window.PulseOpsCurrentServerHostname || this.hostname || (isMaster ? 'mail.sword.local' : 'node');
        let dir = this.cwd || '~';
        if (dir === '/root') dir = '~';
        return `root@${hostname}:${dir}#`;
    }

    resetInputMode(clearInput = false) {
        if (this.pendingSudoCmd) return;

        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;
        if (!isOperator) {
            if (this.prompt) {
                this.prompt.style.color = 'var(--text-dim)';
                this.prompt.textContent = `[viewer@${this.hostname}:ro]$`;
            }
            if (this.input) {
                this.input.type = 'text';
                if (clearInput) this.input.value = '';
                this.input.disabled = true;
                this.input.placeholder = 'Read-only mode: Viewers cannot execute commands in terminal';
            }
            return;
        }

        if (this.prompt) {
            this.prompt.style.color = '';
            this.prompt.textContent = this.getTerminalPrompt();
        }
        if (this.input) {
            this.input.type = 'text';
            this.input.disabled = false;
            if (clearInput) this.input.value = '';
            this.input.placeholder = `Type a command on ${this.hostname} and press Enter...`;
        }
    }

    appendTerminalMessage(msg, color = 'var(--text-dim)') {
        if (!this.body) return;
        const div = document.createElement('div');
        div.className = 'term-output';
        div.style.color = color;
        div.textContent = msg;
        this.body.appendChild(div);
        this.scrollToBottom();
    }

    appendOutput(text, isError = false) {
        if (!this.body || !text) return;
        const div = document.createElement('div');
        div.className = 'term-output';
        if (isError) div.style.color = 'var(--accent-red)';
        div.innerHTML = this.ansiToHtml(text);
        this.body.appendChild(div);
        this.scrollToBottom();
    }

    async executeCommand(cmd) {
        if (!this.body) return;

        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;
        if (!isOperator) {
            window.showToast && window.showToast('Permission denied: Viewer accounts cannot execute terminal commands', 'error');
            this.appendTerminalMessage('[PulseOps RBAC] Permission denied: Viewer accounts cannot execute terminal commands.', 'var(--accent-red)');
            return;
        }

        const sId = window.PulseOpsCurrentServer || this.serverId || 'local-master';
        const isMaster = !sId || sId === 'local-master';
        const hostname = window.PulseOpsCurrentServerHostname || this.hostname || (isMaster ? 'mail.sword.local' : 'node');
        const promptText = this.getTerminalPrompt();

        // Print command line with escaped HTML
        const cmdLine = document.createElement('div');
        cmdLine.className = 'term-output';
        cmdLine.innerHTML = `<span style="color: var(--accent-green); font-weight:700;">${this.escapeHtml(promptText)}</span> <span style="color:#ffffff;">${this.escapeHtml(cmd)}</span>`;
        this.body.appendChild(cmdLine);

        if (cmd === 'clear') {
            this.clearScreen();
            return;
        }

        const outputDiv = document.createElement('div');
        outputDiv.className = 'term-output';
        outputDiv.style.color = 'var(--text-dim)';
        outputDiv.innerHTML = `<span style="color:var(--accent-cyan);">⏳ [${this.escapeHtml(hostname)}] Executing...</span>`;
        this.body.appendChild(outputDiv);
        this.scrollToBottom();

        try {
            const payload = {
                command: cmd,
                server_id: sId,
                cwd: this.cwd || '~'
            };
            if (this.sudoPassword) {
                payload.sudoPassword = this.sudoPassword;
            }

            const authFetch = (window.PulseOpsAuth && PulseOpsAuth.apiFetch) ? PulseOpsAuth.apiFetch : fetch;
            const res = await authFetch('/api/terminal/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            // Update CWD if returned
            if (data.cwd) {
                this.cwd = data.cwd;
                this.updatePromptOnly();
            }

            if (data.need_update) {
                const upgradeCmd = `curl -sSL ${window.location.origin}/api/fleet/agent-update.sh | sudo bash`;
                outputDiv.style.color = '#eab308';
                outputDiv.innerHTML = `[PulseOps] Remote Agent v1 detected on ${this.escapeHtml(hostname)}. Upgrade required to execute commands remotely.<br>` +
                    `<span style="color:#10b981;">Run on ${this.escapeHtml(hostname)}:</span> <code>${upgradeCmd}</code>`;
                this.scrollToBottom();
                return;
            }

            if (data.requirePassword) {
                if (data.isInvalidPassword) {
                    this.sudoPassword = '';
                    outputDiv.style.color = 'var(--accent-red)';
                    outputDiv.textContent = data.error || '[sudo] 1 incorrect password attempt.';
                    this.setSudoPasswordPromptMode(cmd, true);
                } else {
                    outputDiv.style.color = '#eab308';
                    outputDiv.textContent = '[sudo] Sudo privilege required. Please enter password below.';
                    this.setSudoPasswordPromptMode(cmd, false);
                }
                this.scrollToBottom();
                return;
            }

            if (data.success) {
                let htmlOut = '';
                if (data.stdout) {
                    htmlOut += this.ansiToHtml(data.stdout);
                }
                if (data.stderr) {
                    if (htmlOut) htmlOut += '\n';
                    htmlOut += `<span style="color:#f59e0b;">${this.ansiToHtml(data.stderr)}</span>`;
                }
                if (!htmlOut) {
                    htmlOut = '<span style="color:var(--text-dim); font-style:italic;">Command completed with no output (exit code 0).</span>';
                }
                outputDiv.style.color = '#e2e8f0';
                outputDiv.innerHTML = htmlOut;
            } else {
                outputDiv.style.color = 'var(--accent-red)';
                const errMsg = data.error || data.stderr || data.detail || 'Execution failed.';
                if (data.stdout) {
                    outputDiv.innerHTML = `${this.ansiToHtml(data.stdout)}\n<span style="color:var(--accent-red);">${this.ansiToHtml(errMsg)}</span>`;
                } else {
                    outputDiv.innerHTML = this.ansiToHtml(errMsg);
                }
            }
        } catch (e) {
            outputDiv.style.color = 'var(--accent-red)';
            outputDiv.textContent = `Network error running command: ${e.message || e}`;
        }

        this.scrollToBottom();
    }
}

window.logViewer = null;
window.logStreamMgr = null;
window.webTerminal = null;

document.addEventListener('DOMContentLoaded', () => {
    window.logViewer = new LogStreamViewer();
    window.logStreamMgr = {
        appendLog: (entry) => window.logViewer && window.logViewer.pushLog(entry)
    };
    window.webTerminal = new WebTerminal();
});
