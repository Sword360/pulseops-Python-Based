/**
 * PulseOps Enterprise — Real-Time Linux Infrastructure Management
 * ============================================================================
 * Module:      commands.js
 * Description: Operational runbooks, saved command executor, parameter interpolation modal, and batch runner.
 *
 * @author      Najmul Islam
 * @developer   Najmul Islam
 * @contact     f2pnajmul@gmail.com
 * @license     MIT License (see LICENSE file for details)
 * @copyright   (c) 2026 Najmul Islam. All rights reserved.
 * ============================================================================
 */

function _authCmdFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class CommandsManager {
    constructor() {
        this.commands = [];
        this.searchQuery = '';
        this.modal = null;

        this.initDOM();
    }

    initDOM() {
        this.modal = document.getElementById('runbooks-modal');
        this.listContainer = document.getElementById('runbooks-list');
        this.searchInput = document.getElementById('runbooks-search');
        this.badgeCount = document.getElementById('runbooks-badge-count');
        this.addBtn = document.getElementById('btn-add-runbook');
        this.createForm = document.getElementById('runbook-create-form');

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase().trim();
                this.render();
            });
        }

        // Terminal open runbooks button
        const openBtn = document.getElementById('btn-term-runbooks');
        if (openBtn) {
            openBtn.addEventListener('click', () => {
                this.openRunbooksModal();
            });
        }

        // Form toggle
        if (this.addBtn && this.createForm) {
            this.addBtn.addEventListener('click', () => {
                const isHidden = this.createForm.style.display === 'none';
                this.createForm.style.display = isHidden ? 'block' : 'none';
                this.addBtn.textContent = isHidden ? '✕ Cancel' : '+ New Runbook';
            });
        }

        // Save command form submit
        const saveSubmitBtn = document.getElementById('btn-save-runbook-submit');
        if (saveSubmitBtn) {
            saveSubmitBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.saveNewRunbook();
            });
        }

        // Runbooks list event delegation
        if (this.listContainer) {
            this.listContainer.addEventListener('click', (e) => {
                const actionBtn = e.target.closest('[data-cmd-action]');
                if (!actionBtn) return;
                const cmdId = parseInt(actionBtn.dataset.cmdId, 10);
                const action = actionBtn.dataset.cmdAction;
                const cmdObj = this.commands.find(c => c.id === cmdId);
                if (!cmdObj) return;

                if (action === 'insert') {
                    this.insertIntoTerminal(cmdObj.command);
                } else if (action === 'execute') {
                    this.executeRunbook(cmdObj);
                } else if (action === 'delete') {
                    this.deleteRunbook(cmdId, cmdObj.name);
                }
            });
        }

        this.loadCommands();
    }

    _getCurrentServerId() {
        return window.PulseOpsCurrentServer || (window.PulseOpsApp ? window.PulseOpsApp.currentServerId : 'local-master');
    }

    _getCurrentServerHostname() {
        const sId = this._getCurrentServerId();
        return window.PulseOpsCurrentServerHostname || (sId === 'local-master' ? 'Master Host' : 'Remote Node');
    }

    async loadCommands() {
        try {
            const res = await _authCmdFetch('/api/commands');
            const data = await res.json();
            if (data.success) {
                this.commands = data.commands || [];
                if (this.badgeCount) this.badgeCount.textContent = this.commands.length;
                this.render();
            }
        } catch (e) {
            console.error('[CommandsManager] Error loading commands:', e);
        }
    }

    openRunbooksModal() {
        if (!this.modal) return;
        this.loadCommands();
        this.modal.classList.add('active');
        this.modal.style.display = 'flex';
        if (this.searchInput) {
            setTimeout(() => this.searchInput.focus(), 60);
        }
    }

    closeModal() {
        if (!this.modal) return;
        this.modal.classList.remove('active');
        this.modal.style.display = 'none';
    }

    insertIntoTerminal(commandText) {
        const termInput = document.getElementById('terminal-input');
        if (termInput) {
            termInput.value = commandText;
            this.closeModal();
            // Switch to terminal tab if not already
            const termTabBtn = document.querySelector('.tab-btn[data-tab="terminal"]');
            if (termTabBtn && !termTabBtn.classList.contains('active')) {
                termTabBtn.click();
            }
            termInput.focus();
            window.showToast && window.showToast('Runbook inserted into terminal prompt.', 'info', 2000);
        }
    }

    async executeRunbook(cmdObj) {
        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;
        if (!isOperator) {
            window.showToast && window.showToast('Permission denied: Viewer accounts cannot execute runbooks.', 'error');
            return;
        }

        // Check if command has placeholders like {{SERVICE}}
        let commandText = cmdObj.command;
        const placeholders = commandText.match(/\{\{([^}]+)\}\}/g);
        const params = {};

        if (placeholders) {
            for (const ph of placeholders) {
                const varName = ph.replace(/[{}]/g, '').trim();
                const val = window.prompt(`Enter value for parameter ${varName}:`, '');
                if (val === null) return; // User cancelled
                params[varName] = val;
            }
        }

        const sId = this._getCurrentServerId();
        const hostname = this._getCurrentServerHostname();

        this.closeModal();
        window.showToast && window.showToast(`Executing "${cmdObj.name}" on ${hostname}...`, 'info', 2500);

        try {
            const res = await _authCmdFetch(`/api/commands/${cmdObj.id}/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    server_id: sId,
                    params: params
                })
            });
            const data = await res.json();

            // Print directly into web terminal output
            if (window.webTerminal && typeof window.webTerminal.appendOutput === 'function') {
                window.webTerminal.appendOutput(`\n\x1b[36m⚡ [Runbook: ${cmdObj.name}] Executing on ${hostname}...\x1b[0m\n`);
                if (data.stdout) window.webTerminal.appendOutput(data.stdout + '\n');
                if (data.stderr) window.webTerminal.appendOutput(`\x1b[31m${data.stderr}\x1b[0m\n`);
                window.webTerminal.appendOutput(`\x1b[32m✔ Runbook completed with exit code ${data.exit_code || 0}\x1b[0m\n`);
            } else {
                if (data.exit_code === 0) {
                    window.showToast && window.showToast(`Runbook "${cmdObj.name}" executed successfully!`, 'success', 3500);
                } else {
                    window.showToast && window.showToast(`Runbook finished with error: ${data.stderr || data.error || 'Check terminal'}`, 'error', 5000);
                }
            }
        } catch (e) {
            window.showToast && window.showToast('Network error executing runbook', 'error');
        }
    }

    async saveNewRunbook() {
        const name = document.getElementById('new-rb-name')?.value.trim();
        const desc = document.getElementById('new-rb-desc')?.value.trim();
        const cmd = document.getElementById('new-rb-cmd')?.value.trim();
        const reqSudo = document.getElementById('new-rb-sudo')?.checked || false;
        const role = document.getElementById('new-rb-role')?.value || 'operator';

        if (!name || !cmd) {
            window.showToast && window.showToast('Name and Command are required.', 'error');
            return;
        }

        const allowedRoles = role === 'admin' ? ['admin'] : (role === 'operator' ? ['admin', 'operator'] : ['admin', 'operator', 'viewer']);

        try {
            const res = await _authCmdFetch('/api/commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name,
                    description: desc,
                    command: cmd,
                    requires_sudo: reqSudo,
                    allowed_roles: allowedRoles
                })
            });
            const data = await res.json();
            if (data.success) {
                window.showToast && window.showToast(`Runbook "${name}" created successfully!`, 'success', 3000);
                if (this.createForm) this.createForm.style.display = 'none';
                if (this.addBtn) this.addBtn.textContent = '+ New Runbook';
                // Reset inputs
                document.getElementById('new-rb-name').value = '';
                document.getElementById('new-rb-desc').value = '';
                document.getElementById('new-rb-cmd').value = '';
                this.loadCommands();
            } else {
                window.showToast && window.showToast(data.error || 'Failed to create runbook.', 'error');
            }
        } catch (e) {
            window.showToast && window.showToast('Network error creating runbook', 'error');
        }
    }

    async deleteRunbook(cmdId, cmdName) {
        const isAdmin = window.PulseOpsAuth ? window.PulseOpsAuth.isAdmin() : true;
        if (!isAdmin) {
            window.showToast && window.showToast('Only Admins can delete saved runbooks.', 'error');
            return;
        }

        if (!window.confirm(`Delete runbook "${cmdName}"?`)) return;

        try {
            const res = await _authCmdFetch(`/api/commands/${cmdId}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                window.showToast && window.showToast(`Runbook deleted.`, 'success', 2500);
                this.loadCommands();
            } else {
                window.showToast && window.showToast(data.error || 'Failed to delete runbook.', 'error');
            }
        } catch (e) {
            window.showToast && window.showToast('Network error deleting runbook', 'error');
        }
    }

    render() {
        if (!this.listContainer) return;
        this.listContainer.innerHTML = '';

        let filtered = this.commands.filter(c => {
            if (!this.searchQuery) return true;
            return c.name.toLowerCase().includes(this.searchQuery) ||
                   (c.description && c.description.toLowerCase().includes(this.searchQuery)) ||
                   c.command.toLowerCase().includes(this.searchQuery);
        });

        if (filtered.length === 0) {
            this.listContainer.innerHTML = `<div style="text-align:center; color:var(--text-dim); padding:2rem;">
                No runbooks found matching search.
            </div>`;
            return;
        }

        const isOperator = window.PulseOpsAuth ? window.PulseOpsAuth.isOperator() : true;
        const isAdmin = window.PulseOpsAuth ? window.PulseOpsAuth.isAdmin() : true;

        filtered.forEach(c => {
            const item = document.createElement('div');
            item.className = 'runbook-card';
            item.style.cssText = 'background:var(--bg-card); border:1px solid var(--border-color); border-radius:8px; padding:0.9rem 1.1rem; display:flex; flex-direction:column; gap:0.5rem; margin-bottom:0.75rem;';

            const sudoBadge = c.requires_sudo 
                ? `<span class="badge" style="background:rgba(234,179,8,0.15); color:#facc15; border:1px solid rgba(234,179,8,0.3); font-size:0.68rem;">🔑 Sudo</span>`
                : '';

            const rolesFormatted = (c.allowed_roles || []).map(r => 
                `<span class="badge badge-inactive" style="font-size:0.65rem;">${r}</span>`
            ).join(' ');

            const safeCmd = c.command.replace(/"/g, '&quot;');
            const safeName = c.name.replace(/"/g, '&quot;');

            let actionBtns = `
                <button class="btn btn-sm btn-secondary" data-cmd-action="insert" data-cmd-id="${c.id}" title="Insert into prompt input" style="padding:0.25rem 0.6rem; font-size:0.75rem;">
                    ✏️ Insert
                </button>
            `;

            if (isOperator && c.can_execute) {
                actionBtns += `
                    <button class="btn btn-sm btn-primary" data-cmd-action="execute" data-cmd-id="${c.id}" title="Execute on current target host" style="padding:0.25rem 0.6rem; font-size:0.75rem;">
                        ⚡ Run Now
                    </button>
                `;
            }

            if (isAdmin) {
                actionBtns += `
                    <button class="btn-action danger" data-cmd-action="delete" data-cmd-id="${c.id}" title="Delete runbook" style="padding:0.2rem 0.5rem; font-size:0.72rem;">
                        🗑️
                    </button>
                `;
            }

            item.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.5rem;">
                    <div>
                        <div style="font-weight:700; color:var(--text-main); font-size:0.95rem; display:flex; align-items:center; gap:0.4rem;">
                            <span>${safeName}</span>
                            ${sudoBadge}
                        </div>
                        <div style="font-size:0.78rem; color:var(--text-dim); margin-top:2px;">${c.description || ''}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:0.35rem;">
                        ${actionBtns}
                    </div>
                </div>
                <div style="background:#04070d; border:1px solid var(--border-color); border-radius:5px; padding:0.45rem 0.75rem; font-family:var(--font-mono); font-size:0.8rem; color:var(--accent-cyan); overflow-x:auto; white-space:nowrap;">
                    ${safeCmd}
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.72rem; color:var(--text-dim);">
                    <div style="display:flex; align-items:center; gap:0.3rem;">Allowed: ${rolesFormatted}</div>
                    <span>ID #${c.id}</span>
                </div>
            `;
            this.listContainer.appendChild(item);
        });
    }
}

// Global initialization
window.commandsMgr = null;
document.addEventListener('DOMContentLoaded', () => {
    window.commandsMgr = new CommandsManager();
});
