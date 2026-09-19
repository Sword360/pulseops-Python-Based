/**
 * PulseOps Enterprise — Real-Time Linux Infrastructure Management
 * ============================================================================
 * Module:      backup.js
 * Description: Backup snapshot manager, tar archive inspection, SHA-256 verification, and disaster recovery client.
 *
 * @author      Najmul Islam
 * @developer   Najmul Islam
 * @contact     f2pnajmul@gmail.com
 * @license     MIT License (see LICENSE file for details)
 * @copyright   (c) 2026 Najmul Islam. All rights reserved.
 * ============================================================================
 */

function _authBackupFetch(url, options = {}) {
    if (window.PulseOpsAuth && PulseOpsAuth.apiFetch) {
        return PulseOpsAuth.apiFetch(url, options);
    }
    return fetch(url, options);
}

class BackupManager {
    constructor() {
        this.backups = [];
        this.stats = null;
        this.isLoading = false;
        this.initDOM();
    }

    initDOM() {
        // Summary stats
        this.statTotalEl = document.getElementById('backup-stat-total');
        this.statSizeEl = document.getElementById('backup-stat-size');
        this.statLatestEl = document.getElementById('backup-stat-latest');
        this.statDirEl = document.getElementById('backup-stat-dir');

        // Table
        this.tableBody = document.getElementById('backup-table-body');
        this.tableLoading = document.getElementById('backup-table-loading');
        this.tableEmpty = document.getElementById('backup-table-empty');

        // Actions
        this.createBtn = document.getElementById('btn-backup-create-modal');
        this.refreshBtn = document.getElementById('btn-backup-refresh');

        // Create Modal
        this.createModal = document.getElementById('modal-create-backup');
        this.createForm = document.getElementById('form-create-backup');
        this.profileSelect = document.getElementById('backup-profile-select');
        this.customPathsGroup = document.getElementById('backup-custom-paths-group');
        this.customPathsInput = document.getElementById('backup-custom-paths');
        this.notesInput = document.getElementById('backup-notes');
        this.submitCreateBtn = document.getElementById('btn-submit-create-backup');

        // Manifest Modal
        this.manifestModal = document.getElementById('modal-backup-manifest');
        this.manifestTitle = document.getElementById('backup-manifest-title');
        this.manifestSubtitle = document.getElementById('backup-manifest-subtitle');
        this.manifestList = document.getElementById('backup-manifest-list');
        this.manifestSearch = document.getElementById('backup-manifest-search');

        // Wire events
        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => this.loadBackups(true));
        }

        if (this.createBtn) {
            this.createBtn.addEventListener('click', () => this.openCreateModal());
        }

        if (this.profileSelect) {
            this.profileSelect.addEventListener('change', (e) => {
                if (this.customPathsGroup) {
                    this.customPathsGroup.style.display = e.target.value === 'custom' ? 'block' : 'none';
                }
            });
        }

        if (this.createForm) {
            this.createForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitBackup();
            });
        }

        if (this.manifestSearch) {
            this.manifestSearch.addEventListener('input', (e) => {
                const q = e.target.value.toLowerCase().trim();
                document.querySelectorAll('#backup-manifest-list .manifest-row').forEach(row => {
                    const txt = row.textContent.toLowerCase();
                    row.style.display = txt.includes(q) ? '' : 'none';
                });
            });
        }

        // Close buttons for modals
        document.querySelectorAll('[data-close-modal="modal-create-backup"]').forEach(b => {
            b.addEventListener('click', () => {
                if (this.createModal) this.createModal.style.display = 'none';
            });
        });

        document.querySelectorAll('[data-close-modal="modal-backup-manifest"]').forEach(b => {
            b.addEventListener('click', () => {
                if (this.manifestModal) this.manifestModal.style.display = 'none';
            });
        });

        // Close on overlay click
        [this.createModal, this.manifestModal].forEach(m => {
            if (m) {
                m.addEventListener('click', (e) => {
                    if (e.target === m) m.style.display = 'none';
                });
            }
        });
    }

    static init() {
        if (!window.backupMgr) {
            window.backupMgr = new BackupManager();
        }
        window.backupMgr.loadBackups();
    }

    async loadBackups(showToastFeedback = false) {
        if (this.isLoading) return;
        this.isLoading = true;

        if (this.tableLoading) this.tableLoading.style.display = 'block';
        if (this.tableEmpty) this.tableEmpty.style.display = 'none';

        try {
            const res = await _authBackupFetch('/api/backups');
            if (res.ok) {
                const data = await res.json();
                this.backups = data.backups || [];
                this.stats = data.stats || {};
                this.renderStats();
                this.renderTable();
                if (showToastFeedback && window.showToast) {
                    window.showToast('Backup snapshots refreshed.', 'success');
                }
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (e) {
            console.error('[Backups] Load error:', e);
            if (window.showToast) window.showToast('Failed to load backups: ' + e.message, 'error');
        } finally {
            this.isLoading = false;
            if (this.tableLoading) this.tableLoading.style.display = 'none';
        }
    }

    renderStats() {
        if (!this.stats) return;
        if (this.statTotalEl) this.statTotalEl.textContent = this.stats.total_count || '0';
        if (this.statSizeEl) this.statSizeEl.textContent = `${this.stats.total_mb || '0'} MB`;
        if (this.statLatestEl) {
            this.statLatestEl.textContent = this.stats.latest_backup ? this.stats.latest_backup.split(' ')[0] : 'None';
        }
        if (this.statDirEl) this.statDirEl.textContent = this.stats.backup_dir || '--';
    }

    renderTable() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';

        if (!this.backups || this.backups.length === 0) {
            if (this.tableEmpty) this.tableEmpty.style.display = 'block';
            return;
        }

        if (this.tableEmpty) this.tableEmpty.style.display = 'none';

        this.backups.forEach(b => {
            const tr = document.createElement('tr');
            const sizeMb = (b.size_bytes / (1024 * 1024)).toFixed(2);
            const checksumShort = b.checksum ? b.checksum.substring(0, 10) + '...' : '--';

            let typeBadge = `<span class="badge" style="background:rgba(56,189,248,0.15); color:var(--accent-cyan); text-transform:uppercase;">${this._escapeHtml(b.backup_type)}</span>`;
            if (b.backup_type === 'pulseops') {
                typeBadge = `<span class="badge" style="background:rgba(168,85,247,0.15); color:var(--accent-purple); text-transform:uppercase;">PulseOps DB</span>`;
            } else if (b.backup_type === 'config') {
                typeBadge = `<span class="badge" style="background:rgba(34,197,94,0.15); color:var(--accent-green); text-transform:uppercase;">Configs /etc</span>`;
            }

            tr.innerHTML = `
                <td>
                    <div style="font-weight:600; font-family:var(--font-mono); font-size:0.85rem; color:var(--text-main);">${this._escapeHtml(b.filename)}</div>
                    <div style="font-size:0.75rem; color:var(--text-dim); margin-top:2px;">${this._escapeHtml(b.notes || b.name)}</div>
                </td>
                <td>${typeBadge}</td>
                <td style="font-family:var(--font-mono); font-size:0.82rem;">${sizeMb} MB <span style="font-size:0.75rem; color:var(--text-dim);">(${b.file_count || 0} files)</span></td>
                <td style="font-family:var(--font-mono); font-size:0.78rem; color:var(--text-muted); cursor:pointer;" title="Click to copy full SHA256" onclick="window.copyToClipboard('${b.checksum}', 'Copied SHA256 checksum!');">
                    ${checksumShort} 📋
                </td>
                <td style="font-size:0.78rem; color:var(--text-dim); white-space:nowrap;">${this._escapeHtml(b.created_at)}</td>
                <td style="text-align:right; white-space:nowrap;">
                    <button class="btn btn-sm btn-secondary" onclick="window.backupMgr.downloadBackup(${b.id})" title="Download archive .tar.gz" style="font-size:0.75rem; padding:0.25rem 0.55rem;">
                        ⬇️ Download
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="window.backupMgr.inspectContents(${b.id})" title="Browse files inside archive" style="font-size:0.75rem; padding:0.25rem 0.55rem;">
                        🔍 Inspect
                    </button>
                    <button class="btn btn-sm btn-secondary operator-only" onclick="window.backupMgr.verifyBackup(${b.id})" title="Verify archive integrity & SHA256" style="font-size:0.75rem; padding:0.25rem 0.55rem;">
                        🛡️ Verify
                    </button>
                    <button class="btn btn-sm btn-danger admin-only" onclick="window.backupMgr.deleteBackup(${b.id})" title="Delete backup" style="font-size:0.75rem; padding:0.25rem 0.55rem;">
                        🗑️
                    </button>
                </td>
            `;
            this.tableBody.appendChild(tr);
        });
    }

    openCreateModal() {
        if (this.createModal) {
            this.createModal.style.display = 'flex';
            if (this.profileSelect) this.profileSelect.value = 'config';
            if (this.customPathsGroup) this.customPathsGroup.style.display = 'none';
            if (this.notesInput) this.notesInput.value = '';
        }
    }

    async submitBackup() {
        const type = this.profileSelect?.value || 'config';
        const notes = this.notesInput?.value?.trim() || '';
        let customPaths = [];

        if (type === 'custom') {
            const raw = this.customPathsInput?.value?.trim() || '';
            if (!raw) {
                if (window.showToast) window.showToast('Please specify at least one path to backup.', 'warning');
                return;
            }
            customPaths = raw.split(',').map(s => s.trim()).filter(Boolean);
        }

        if (this.submitCreateBtn) {
            this.submitCreateBtn.disabled = true;
            this.submitCreateBtn.textContent = '⏳ Creating Snapshot...';
        }

        try {
            const res = await _authBackupFetch('/api/backups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, custom_paths: customPaths, notes })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                if (this.createModal) this.createModal.style.display = 'none';
                if (window.showToast) {
                    window.showToast(`Backup snapshot created successfully! (${data.size_mb} MB)`, 'success');
                }
                await this.loadBackups();
            } else {
                throw new Error(data.error || 'Backup creation failed');
            }
        } catch (e) {
            console.error('[Backups] Create error:', e);
            if (window.showToast) window.showToast('Backup error: ' + e.message, 'error');
        } finally {
            if (this.submitCreateBtn) {
                this.submitCreateBtn.disabled = false;
                this.submitCreateBtn.textContent = 'Create Backup Now';
            }
        }
    }

    downloadBackup(id) {
        window.open(`/api/backups/${id}/download`, '_blank');
    }

    async verifyBackup(id) {
        if (window.showToast) window.showToast('Verifying archive integrity...', 'info');
        try {
            const res = await _authBackupFetch(`/api/backups/${id}/verify`, { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.verified) {
                if (window.showToast) {
                    window.showToast(`✅ Archive #${id} integrity verified! (${data.member_count} files, SHA-256 match)`, 'success', 5000);
                }
            } else {
                if (window.showToast) {
                    window.showToast(`❌ Verification failed: ${data.message || data.error}`, 'error', 6000);
                }
            }
        } catch (e) {
            if (window.showToast) window.showToast('Verification error: ' + e.message, 'error');
        }
    }

    async inspectContents(id) {
        if (!this.manifestModal) return;
        this.manifestModal.style.display = 'flex';
        if (this.manifestTitle) this.manifestTitle.textContent = `Archive Manifest #${id}`;
        if (this.manifestList) this.manifestList.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-dim);">Reading archive contents...</div>';

        try {
            const res = await _authBackupFetch(`/api/backups/${id}/contents`);
            const data = await res.json();
            if (res.ok && data.success) {
                if (this.manifestSubtitle) {
                    this.manifestSubtitle.textContent = `${data.filename} — ${data.total_items} indexed entries`;
                }
                this.renderManifest(data.items || []);
            } else {
                throw new Error(data.error || 'Failed to read manifest');
            }
        } catch (e) {
            if (this.manifestList) {
                this.manifestList.innerHTML = `<div style="color:var(--accent-red); padding:1.5rem;">${this._escapeHtml(e.message)}</div>`;
            }
        }
    }

    renderManifest(items) {
        if (!this.manifestList) return;
        if (items.length === 0) {
            this.manifestList.innerHTML = '<div style="color:var(--text-dim); padding:1rem;">Archive contains no files.</div>';
            return;
        }

        this.manifestList.innerHTML = items.map(item => {
            const icon = item.is_dir ? '📁' : '📄';
            const sizeStr = item.is_dir ? '<span style="color:var(--text-dim);">DIR</span>' : `${(item.size / 1024).toFixed(1)} KB`;
            return `
                <div class="manifest-row" style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border-bottom:1px solid rgba(255,255,255,0.05); font-family:var(--font-mono); font-size:0.8rem;">
                    <span style="color:var(--text-main); word-break:break-all;">${icon} ${this._escapeHtml(item.name)}</span>
                    <span style="color:var(--text-muted); font-size:0.75rem; white-space:nowrap; margin-left:1rem;">${sizeStr}</span>
                </div>
            `;
        }).join('');
    }

    async deleteBackup(id) {
        if (!confirm(`Permanently delete backup snapshot #${id}? This action cannot be undone.`)) return;

        try {
            const res = await _authBackupFetch(`/api/backups/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(`Backup #${id} deleted.`, 'info');
                await this.loadBackups();
            } else {
                throw new Error(data.error || 'Delete failed');
            }
        } catch (e) {
            if (window.showToast) window.showToast('Delete error: ' + e.message, 'error');
        }
    }

    _escapeHtml(str) {
        return (str || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

// Attach globally
window.BackupManager = BackupManager;
