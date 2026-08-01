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
}

class WebTerminal {
    constructor() {
        this.body = document.getElementById('terminal-body');
        this.input = document.getElementById('terminal-input');
        this.prompt = document.getElementById('term-prompt');
        this.history = [];
        this.historyIndex = -1;
        this.sudoPassword = '';
        this.pendingSudoCmd = null;

        this.initDOM();
    }

    initDOM() {
        if (this.input) {
            this.input.addEventListener('keydown', (e) => {
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
                        this.executeCommand(val);
                        this.history.push(val);
                        this.historyIndex = this.history.length;
                        this.input.value = '';
                    }
                } else if (e.key === 'ArrowUp' && !this.pendingSudoCmd) {
                    if (this.historyIndex > 0) {
                        this.historyIndex--;
                        this.input.value = this.history[this.historyIndex];
                    }
                } else if (e.key === 'ArrowDown' && !this.pendingSudoCmd) {
                    if (this.historyIndex < this.history.length - 1) {
                        this.historyIndex++;
                        this.input.value = this.history[this.historyIndex];
                    } else {
                        this.historyIndex = this.history.length;
                        this.input.value = '';
                    }
                }
            });
        }

        // Preset command buttons
        document.querySelectorAll('.btn-preset').forEach(btn => {
            if (btn.id === 'btn-sudo-auth') return;
            btn.addEventListener('click', () => {
                const cmd = btn.dataset.cmd;
                if (cmd && this.input && !this.pendingSudoCmd) {
                    this.input.value = cmd;
                    this.executeCommand(cmd);
                    this.input.value = '';
                }
            });
        });

        // Sudo Auth Button
        const sudoBtn = document.getElementById('btn-sudo-auth');
        if (sudoBtn) {
            sudoBtn.addEventListener('click', () => {
                const currentStatus = this.sudoPassword ? 'Set' : 'Not set';
                const pass = prompt(`Configure Sudo Password (Current status: ${currentStatus})\nLeave blank to clear saved password:`, this.sudoPassword || '');
                if (pass !== null) {
                    this.sudoPassword = pass;
                    this.appendTerminalMessage(`[sudo] Sudo credentials updated for web terminal session.`, '#eab308');
                }
            });
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

    resetInputMode() {
        if (this.prompt) {
            this.prompt.style.color = '';
            this.prompt.textContent = 'pulseops@linux:~$';
        }
        if (this.input) {
            this.input.type = 'text';
            this.input.value = '';
            this.input.placeholder = 'Type a command (e.g. sudo apt update, uptime) and press Enter...';
        }
    }

    appendTerminalMessage(msg, color = 'var(--text-dim)') {
        if (!this.body) return;
        const div = document.createElement('div');
        div.className = 'term-output';
        div.style.color = color;
        div.textContent = msg;
        this.body.appendChild(div);
        this.body.scrollTop = this.body.scrollHeight;
    }

    async executeCommand(cmd) {
        if (!this.body) return;

        // Print command line
        const cmdLine = document.createElement('div');
        cmdLine.className = 'term-output';
        cmdLine.innerHTML = `<span style="color: var(--accent-green)">pulseops@linux:~$</span> ${cmd}`;
        this.body.appendChild(cmdLine);

        if (cmd === 'clear') {
            this.body.innerHTML = '';
            return;
        }

        const outputDiv = document.createElement('div');
        outputDiv.className = 'term-output';
        outputDiv.style.color = 'var(--text-dim)';
        outputDiv.textContent = 'Executing command...';
        this.body.appendChild(outputDiv);
        this.body.scrollTop = this.body.scrollHeight;

        try {
            const payload = { command: cmd };
            if (this.sudoPassword) {
                payload.sudoPassword = this.sudoPassword;
            }

            const res = await fetch('/api/terminal/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();

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
                return;
            }

            if (data.success) {
                outputDiv.style.color = '#e2e8f0';
                outputDiv.textContent = data.stdout || (data.stderr ? data.stderr : 'Command completed with no output.');
            } else {
                outputDiv.style.color = 'var(--accent-red)';
                outputDiv.textContent = data.error || data.stderr || 'Execution failed.';
            }
        } catch (e) {
            outputDiv.style.color = 'var(--accent-red)';
            outputDiv.textContent = 'Network error running command.';
        }

        this.body.scrollTop = this.body.scrollHeight;
    }
}

window.logViewer = null;
window.webTerminal = null;

document.addEventListener('DOMContentLoaded', () => {
    window.logViewer = new LogStreamViewer();
    window.webTerminal = new WebTerminal();
});
