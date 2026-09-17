/**
 * settings.js — PulseOps Enterprise System Settings & Policies Manager
 *
 * Provides complete configuration management across:
 * - General & Branding
 * - Observability & Telemetry Resolution
 * - Fleet Polling & Global Alert Thresholds
 * - Webhook & SMTP Alert Channels
 * - SSL / TLS Certificate Watchdog
 * - Security Policies & Personal 2FA
 * - Web Terminal & Runbooks Preferences
 * - Database Storage, Optimization, Purging & Backup
 */

const SettingsManager = (() => {
    let _settings = {};
    let _activeCategory = 'all';

    // ── Load Settings ─────────────────────────────────────────────────────────

    async function loadSettings() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings');
            if (!resp || !resp.ok) return;
            _settings = await resp.json();
            populateForm();
            loadDatabaseStats();
            if (window.PulseOpsApp && typeof window.PulseOpsApp.applyNavigationVisibility === 'function') {
                window.PulseOpsApp.applyNavigationVisibility(_settings);
            }
        } catch (e) {
            console.error('[Settings] Load error:', e);
        }
    }

    // ── Populate Form Fields ──────────────────────────────────────────────────

    function populateForm() {
        document.querySelectorAll('[data-setting-key]').forEach(el => {
            const key = el.dataset.settingKey;
            const val = _settings[key];
            if (val === undefined || val === null) return;

            if (el.type === 'checkbox') {
                el.checked = val === 'true' || val === true || val === '1';
            } else {
                el.value = val;
            }
            el.classList.remove('setting-dirty');
            el.closest('.toggle-switch')?.classList.remove('setting-dirty');
        });

        updateDirtyState();

        // 2FA status indicator
        const statusText = document.getElementById('2fa-status-text');
        if (statusText) {
            const user = PulseOpsAuth.getUser();
            if (user && user.two_factor_enabled) {
                statusText.innerHTML = '<span style="color:#4ade80;">● Active &amp; Enforced</span>';
            } else {
                statusText.innerHTML = '<span style="color:var(--text-dim);">○ Not Configured</span>';
            }
        }
    }

    // ── Dirty State Change Tracking ───────────────────────────────────────────

    function checkIsDirty(el) {
        const key = el.dataset.settingKey;
        if (!key) return false;
        const origVal = _settings[key];
        if (origVal === undefined || origVal === null) return false;

        if (el.type === 'checkbox') {
            const origBool = origVal === 'true' || origVal === true || origVal === '1';
            return el.checked !== origBool;
        } else {
            const curVal = el.value.trim();
            if (curVal === '••••••••' && key.includes('password')) return false;
            return String(curVal) !== String(origVal);
        }
    }

    function updateDirtyState() {
        let dirtyCount = 0;
        document.querySelectorAll('[data-setting-key]').forEach(el => {
            const isDirty = checkIsDirty(el);
            if (isDirty) {
                dirtyCount++;
                el.classList.add('setting-dirty');
                el.closest('.toggle-switch')?.classList.add('setting-dirty');
            } else {
                el.classList.remove('setting-dirty');
                el.closest('.toggle-switch')?.classList.remove('setting-dirty');
            }
        });

        const saveAllBtn = document.getElementById('btn-save-all-settings');
        const dirtyBadge = document.getElementById('dirty-count-badge');
        if (saveAllBtn && dirtyBadge) {
            dirtyBadge.textContent = dirtyCount;
            saveAllBtn.style.display = dirtyCount > 0 ? 'inline-flex' : 'none';
        }
    }

    function initDirtyTracking() {
        const grid = document.getElementById('settings-cards-grid');
        if (!grid) return;

        grid.addEventListener('input', (e) => {
            if (e.target.matches('[data-setting-key]')) {
                updateDirtyState();
            }
        });

        grid.addEventListener('change', (e) => {
            if (e.target.matches('[data-setting-key]')) {
                updateDirtyState();
            }
        });
    }

    // ── Save Settings Section ─────────────────────────────────────────────────

    async function saveSection(sectionId) {
        const section = document.getElementById(sectionId);
        if (!section) return;

        const payload = {};
        section.querySelectorAll('[data-setting-key]').forEach(el => {
            const key = el.dataset.settingKey;
            if (el.type === 'checkbox') {
                payload[key] = String(el.checked);
            } else {
                const val = el.value.trim();
                // Don't overwrite masked password placeholders
                if (val !== '••••••••') {
                    payload[key] = val;
                }
            }
        });

        const btn = section.querySelector('[data-save-section]');
        const origText = btn ? btn.textContent : 'Save';
        if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings', {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Settings updated (${data.updated_count} fields saved)`, 'success');
                Object.assign(_settings, payload);
                section.querySelectorAll('[data-setting-key]').forEach(el => {
                    el.classList.remove('setting-dirty');
                    el.closest('.toggle-switch')?.classList.remove('setting-dirty');
                });
                updateDirtyState();
                if (window.PulseOpsApp && typeof window.PulseOpsApp.applyNavigationVisibility === 'function') {
                    window.PulseOpsApp.applyNavigationVisibility(_settings);
                }
            } else {
                showToast(data.detail || 'Failed to save settings', 'error');
            }
        } catch (err) {
            console.error('[Settings] Save error:', err);
            showToast('Network error saving settings', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = origText; }
        }
    }

    // ── Save All Modified Settings ────────────────────────────────────────────

    async function saveAll() {
        const payload = {};
        let changedCount = 0;

        document.querySelectorAll('[data-setting-key]').forEach(el => {
            const key = el.dataset.settingKey;
            if (checkIsDirty(el)) {
                changedCount++;
                if (el.type === 'checkbox') {
                    payload[key] = String(el.checked);
                } else {
                    const val = el.value.trim();
                    if (val !== '••••••••') {
                        payload[key] = val;
                    }
                }
            }
        });

        if (changedCount === 0) {
            showToast('No unsaved changes detected', 'info');
            return;
        }

        const btn = document.getElementById('btn-save-all-settings');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span> Saving...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings', {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`All changes saved (${data.updated_count} fields updated)`, 'success');
                Object.assign(_settings, payload);
                document.querySelectorAll('[data-setting-key]').forEach(el => {
                    el.classList.remove('setting-dirty');
                    el.closest('.toggle-switch')?.classList.remove('setting-dirty');
                });
                updateDirtyState();
                if (window.PulseOpsApp && typeof window.PulseOpsApp.applyNavigationVisibility === 'function') {
                    window.PulseOpsApp.applyNavigationVisibility(_settings);
                }
            } else {
                showToast(data.detail || 'Failed to save settings', 'error');
            }
        } catch (err) {
            console.error('[Settings] Save All error:', err);
            showToast('Network error saving settings', 'error');
        } finally {
            if (btn) { btn.disabled = false; }
            updateDirtyState();
        }
    }

    // ── Category Navigation Tabs ──────────────────────────────────────────────

    function initCategoryNav() {
        const nav = document.getElementById('settings-tab-nav');
        if (!nav) return;
        nav.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                nav.scrollLeft += e.deltaY * 0.85;
            }
        }, { passive: false });

        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('.settings-tab-btn');
            if (!btn) return;

            nav.querySelectorAll('.settings-tab-btn').forEach(b => {
                b.classList.toggle('active', b === btn);
                b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
            });

            _activeCategory = btn.dataset.category || 'all';

            // Clear search filter when switching categories for clarity
            const searchInput = document.getElementById('settings-search-input');
            const clearBtn = document.getElementById('settings-search-clear');
            if (searchInput && searchInput.value) {
                searchInput.value = '';
                if (clearBtn) clearBtn.style.display = 'none';
            }

            applyCategoryFilter();
        });
    }

    function applyCategoryFilter() {
        const cards = document.querySelectorAll('#settings-cards-grid .settings-card');
        const emptyState = document.getElementById('settings-search-empty');
        if (emptyState) emptyState.style.display = 'none';

        cards.forEach(card => {
            const cat = card.dataset.cardCategory || '';
            const matches = _activeCategory === 'all' || cat.split(/\s+/).includes(_activeCategory);
            card.classList.toggle('card-hidden', !matches);
            // Restore all items within visible cards
            card.querySelectorAll('.setting-item, .settings-module-tile, .theme-card-tile').forEach(item => {
                item.classList.remove('item-hidden');
            });
        });
    }

    // ── Instant Quick Search & Filtering ─────────────────────────────────────

    function initSearch() {
        const input = document.getElementById('settings-search-input');
        const clearBtn = document.getElementById('settings-search-clear');
        const emptyState = document.getElementById('settings-search-empty');
        const emptyQueryText = document.getElementById('settings-search-query-text');
        const emptyClearBtn = document.getElementById('btn-clear-settings-search');

        if (!input) return;

        function handleSearch() {
            const query = input.value.trim().toLowerCase();
            if (clearBtn) clearBtn.style.display = query.length > 0 ? 'block' : 'none';

            if (!query) {
                applyCategoryFilter();
                return;
            }

            const cards = document.querySelectorAll('#settings-cards-grid .settings-card');
            let totalVisibleItems = 0;

            cards.forEach(card => {
                let visibleInCard = 0;

                // Match setting-item rows
                card.querySelectorAll('.setting-item').forEach(item => {
                    const label = (item.querySelector('.setting-label')?.textContent || '').toLowerCase();
                    const hint = (item.querySelector('.setting-hint')?.textContent || '').toLowerCase();
                    const searchTerms = (item.dataset.searchTerms || '').toLowerCase();
                    const isMatch = label.includes(query) || hint.includes(query) || searchTerms.includes(query);

                    item.classList.toggle('item-hidden', !isMatch);
                    if (isMatch) visibleInCard++;
                });

                // Match settings-module-tile rows
                card.querySelectorAll('.settings-module-tile').forEach(tile => {
                    const title = (tile.querySelector('.module-tile-title')?.textContent || '').toLowerCase();
                    const desc = (tile.querySelector('.module-tile-desc')?.textContent || '').toLowerCase();
                    const searchTerms = (tile.dataset.searchTerms || '').toLowerCase();
                    const isMatch = title.includes(query) || desc.includes(query) || searchTerms.includes(query);

                    tile.classList.toggle('item-hidden', !isMatch);
                    if (isMatch) visibleInCard++;
                });

                // Match theme-card-tile rows
                card.querySelectorAll('.theme-card-tile').forEach(tile => {
                    const title = (tile.querySelector('.theme-card-title')?.textContent || '').toLowerCase();
                    const desc = (tile.querySelector('.theme-card-desc')?.textContent || '').toLowerCase();
                    const searchTerms = (tile.dataset.searchTerms || '').toLowerCase();
                    const isMatch = title.includes(query) || desc.includes(query) || searchTerms.includes(query);

                    tile.classList.toggle('item-hidden', !isMatch);
                    if (isMatch) visibleInCard++;
                });

                // Check title of card itself
                const cardTitle = (card.querySelector('.card-title')?.textContent || '').toLowerCase();
                if (cardTitle.includes(query)) {
                    card.querySelectorAll('.setting-item, .settings-module-tile').forEach(i => i.classList.remove('item-hidden'));
                    visibleInCard = 1;
                }

                card.classList.toggle('card-hidden', visibleInCard === 0);
                totalVisibleItems += visibleInCard;
            });

            const emptyState = document.getElementById('settings-search-empty');
            const queryText = document.getElementById('settings-search-query-text');
            if (emptyState) {
                emptyState.style.display = totalVisibleItems === 0 ? 'flex' : 'none';
                if (queryText) queryText.textContent = query;
            }
        }

        input.addEventListener('input', handleSearch);

        function clearSearch() {
            input.value = '';
            if (clearBtn) clearBtn.style.display = 'none';
            applyCategoryFilter();
            input.focus();
        }

        if (clearBtn) clearBtn.addEventListener('click', clearSearch);
        if (emptyClearBtn) emptyClearBtn.addEventListener('click', clearSearch);
    }

    // ── Webhook Alert Channel Test ────────────────────────────────────────────

    async function testWebhook() {
        const btn = document.getElementById('test-webhook-btn');
        const result = document.getElementById('webhook-test-result');
        const urlInput = document.getElementById('setting-webhook-url');
        const formatSelect = document.getElementById('setting-webhook-format');

        const webhookUrl = urlInput ? urlInput.value.trim() : '';
        const webhookFormat = formatSelect ? formatSelect.value : 'slack';

        if (btn) { btn.disabled = true; btn.textContent = 'Testing...'; }
        if (result) { result.textContent = ''; result.style.display = 'none'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings/test-webhook', {
                method: 'POST',
                body: JSON.stringify({ webhook_url: webhookUrl, webhook_format: webhookFormat })
            });
            const data = await resp.json();

            if (result) {
                result.style.display = 'block';
                if (resp.ok && data.success) {
                    result.style.background = 'rgba(34, 197, 94, 0.15)';
                    result.style.border = '1px solid rgba(34, 197, 94, 0.3)';
                    result.style.color = '#4ade80';
                    result.innerHTML = `✅ <strong>Webhook Dispatched!</strong> Target server accepted payload (HTTP ${data.status_code || 200}).`;
                    showToast('Webhook notification delivered successfully!', 'success');
                } else {
                    result.style.background = 'rgba(239, 68, 68, 0.15)';
                    result.style.border = '1px solid rgba(239, 68, 68, 0.3)';
                    result.style.color = '#f87171';
                    result.innerHTML = `❌ <strong>Webhook Failed:</strong> ${data.detail || 'Could not reach endpoint'}`;
                    showToast('Webhook delivery failed', 'error');
                }
            }
        } catch (err) {
            if (result) {
                result.style.display = 'block';
                result.style.background = 'rgba(239, 68, 68, 0.15)';
                result.style.border = '1px solid rgba(239, 68, 68, 0.3)';
                result.style.color = '#f87171';
                result.textContent = '❌ Network error communicating with server';
            }
            showToast('Network error executing webhook test', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🚀 Test Webhook'; }
        }
    }

    // ── SMTP Test ─────────────────────────────────────────────────────────────

    async function testSMTP() {
        const btn = document.getElementById('test-smtp-btn');
        const result = document.getElementById('smtp-test-result');
        if (btn) { btn.disabled = true; btn.textContent = 'Sending test...'; }
        if (result) { result.textContent = ''; result.style.display = 'none'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings/test-smtp', { method: 'POST' });
            const data = await resp.json().catch(() => ({}));

            if (result) {
                result.style.display = 'block';
                if (resp && resp.ok && data.success) {
                    result.style.background = 'rgba(34, 197, 94, 0.15)';
                    result.style.border = '1px solid rgba(34, 197, 94, 0.3)';
                    result.style.color = '#4ade80';
                    result.innerHTML = '✅ <strong>Test email sent successfully.</strong> Check your inbox.';
                    showToast('SMTP test email sent', 'success');
                } else {
                    result.style.background = 'rgba(239, 68, 68, 0.15)';
                    result.style.border = '1px solid rgba(239, 68, 68, 0.3)';
                    result.style.color = '#f87171';
                    result.innerHTML = `❌ <strong>SMTP Test Failed:</strong> ${data.detail || 'Verify host, port, credentials, and TLS'}`;
                    showToast('SMTP test failed', 'error');
                }
            }
        } catch {
            if (result) {
                result.style.display = 'block';
                result.style.background = 'rgba(239, 68, 68, 0.15)';
                result.style.border = '1px solid rgba(239, 68, 68, 0.3)';
                result.style.color = '#f87171';
                result.textContent = '❌ Network error — cannot reach server';
            }
            showToast('Network error during SMTP test', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '📧 Test SMTP'; }
        }
    }

    // ── Database Health & Maintenance ─────────────────────────────────────────

    async function loadDatabaseStats() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/database/stats');
            if (!resp || !resp.ok) return;
            const stats = await resp.json();

            const sizeEl = document.getElementById('db-stat-size');
            const pathEl = document.getElementById('db-stat-path');
            const snapsEl = document.getElementById('db-stat-snapshots');
            const logsEl = document.getElementById('db-stat-logs');
            const serversEl = document.getElementById('db-stat-servers');
            const sslEl = document.getElementById('db-stat-ssl');

            if (sizeEl) sizeEl.textContent = `${stats.total_size_mb || 0} MB`;
            if (pathEl) pathEl.textContent = stats.db_path || 'pulseops.db';
            if (snapsEl) snapsEl.textContent = (stats.snapshots_count || 0).toLocaleString();
            if (logsEl) logsEl.textContent = (stats.audit_logs_count || 0).toLocaleString();
            if (serversEl) serversEl.textContent = (stats.servers_count || 0).toLocaleString();
            if (sslEl) sslEl.textContent = (stats.monitored_domains_count || 0).toLocaleString();
        } catch (e) {
            console.error('[Settings] DB stats error:', e);
        }
    }

    async function vacuumDatabase() {
        const btn = document.getElementById('btn-db-vacuum');
        if (btn) { btn.disabled = true; btn.textContent = 'Optimizing...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/database/vacuum', { method: 'POST' });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Database optimized (VACUUM complete, ${data.reclaimed_kb || 0} KB reclaimed)`, 'success');
                await loadDatabaseStats();
            } else {
                showToast(data.detail || 'VACUUM operation failed', 'error');
            }
        } catch (e) {
            showToast('Network error optimizing database', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🧹 Optimize & VACUUM Database'; }
        }
    }

    async function purgeMetrics() {
        if (!confirm('Purge historical metric snapshots older than the configured retention period? This reclaims space while keeping server configurations and audit logs.')) {
            return;
        }

        const btn = document.getElementById('btn-db-purge');
        if (btn) { btn.disabled = true; btn.textContent = 'Purging...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/database/purge-metrics', { method: 'POST' });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Metric history purged (older than ${data.retention_hours} hours)`, 'success');
                await loadDatabaseStats();
            } else {
                showToast(data.detail || 'Failed to purge metrics', 'error');
            }
        } catch (e) {
            showToast('Network error purging metrics', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🗑️ Purge Expired Metric History'; }
        }
    }

    async function resetDefaults() {
        if (!confirm('⚠️ Are you sure you want to reset all system settings to factory defaults? All custom thresholds, polling intervals, and alert channels will be reset. User accounts and fleet servers will NOT be deleted.')) {
            return;
        }

        const btn = document.getElementById('btn-reset-defaults');
        if (btn) { btn.disabled = true; btn.textContent = 'Resetting...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings/reset-defaults', { method: 'POST' });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast('Settings successfully reset to factory defaults', 'success');
                await loadSettings();
            } else {
                showToast(data.detail || 'Failed to reset settings', 'error');
            }
        } catch (e) {
            showToast('Network error resetting settings', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🔄 Reset Settings to Defaults'; }
        }
    }

    async function downloadBackup() {
        const btn = document.getElementById('backup-db-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Preparing...'; }
        try {
            const token = PulseOpsAuth.getAccessToken();
            const resp = await fetch('/api/admin/backup', {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!resp.ok) { showToast('Backup failed — not authorized', 'error'); return; }
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pulseops-backup-${new Date().toISOString().split('T')[0]}.db`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Database backup downloaded successfully', 'success');
        } catch {
            showToast('Backup download failed', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '💾 Download Backup'; }
        }
    }

    function triggerRestore() {
        const confirmMsg = "⚠️ RESTORE DATABASE WARNING:\n\nRestoring an external database backup will replace all current users, fleet servers, telemetry history, and settings.\n\nAn automated safety backup of your existing database will be created before restoring.\n\nDo you want to proceed and select a .db backup file to restore?";
        if (!confirm(confirmMsg)) return;

        const fileInput = document.getElementById('db-restore-file-input');
        if (fileInput) {
            fileInput.value = '';
            fileInput.click();
        }
    }

    async function handleRestoreFile(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const btn = document.getElementById('restore-db-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Restoring DB...'; }

        showToast('Uploading and verifying database backup...', 'info', 4000);

        try {
            const token = PulseOpsAuth.getAccessToken();
            const resp = await fetch('/api/admin/restore', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/octet-stream'
                },
                body: file
            });

            let data = {};
            try {
                data = await resp.json();
            } catch {}

            if (!resp.ok) {
                showToast(data.detail || 'Database restore failed', 'error', 6000);
                return;
            }

            const safetyBakMsg = data.safety_backup ? ` (Backup: ${data.safety_backup})` : '';
            showToast('✅ Database restored successfully! Reloading in 2s...' + safetyBakMsg, 'success', 5000);

            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } catch (err) {
            showToast('Restore network error: ' + (err.message || 'Unknown failure'), 'error', 6000);
        } finally {
            event.target.value = '';
            if (btn) { btn.disabled = false; btn.textContent = '📥 Restore Database'; }
        }
    }

    // ── 2FA Enrollment ────────────────────────────────────────────────────────

    async function setup2FA() {
        const btn = document.getElementById('setup-2fa-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/auth/2fa/setup', { method: 'POST' });
            if (!resp || !resp.ok) { showToast('2FA setup unavailable', 'error'); return; }
            const data = await resp.json();

            const panel = document.getElementById('2fa-setup-panel');
            if (panel) {
                document.getElementById('2fa-secret-display').textContent = data.secret || '';
                const uriEl = document.getElementById('2fa-otpauth-uri');
                if (uriEl) uriEl.textContent = data.otpauth_uri || '';
                if (data.qr_data_url) {
                    const img = document.getElementById('2fa-qr-img');
                    if (img) { img.src = data.qr_data_url; img.style.display = 'block'; }
                }
                panel.style.display = 'block';
            }
        } catch {
            showToast('Failed to initialize 2FA', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🔐 Setup 2FA'; }
        }
    }

    async function verify2FA() {
        const code = document.getElementById('2fa-verify-code')?.value.trim();
        if (!code || code.length !== 6) { showToast('Enter a 6-digit verification code', 'error'); return; }

        const btn = document.getElementById('verify-2fa-btn');
        if (btn) { btn.disabled = true; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/auth/2fa/verify', {
                method: 'POST',
                body: JSON.stringify({ code }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast('2FA enabled successfully!', 'success');
                document.getElementById('2fa-setup-panel').style.display = 'none';
                document.getElementById('2fa-status-text').innerHTML = '<span style="color:var(--accent-green);">● Active &amp; Enforced</span>';
                if (data.backup_codes) {
                    renderBackupCodes(data.backup_codes);
                }
            } else {
                showToast(data.detail || 'Invalid verification code', 'error');
            }
        } catch {
            showToast('Verification failed', 'error');
        } finally {
            if (btn) { btn.disabled = false; }
        }
    }

    function renderBackupCodes(codes) {
        const container = document.getElementById('backup-codes-container');
        if (!container || !codes) return;
        container.innerHTML = `
            <div style="font-weight:700; font-size:0.85rem; color:var(--text-main); margin-bottom:0.5rem;">
                🔑 Save these backup codes — they can only be displayed once:
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(130px, 1fr)); gap:0.4rem; margin-bottom:0.75rem;">
                ${codes.map(c => `<code style="background:rgba(0,0,0,0.4); padding:0.3rem 0.5rem; border-radius:4px; font-family:var(--font-mono); color:var(--accent-cyan); font-size:0.8rem; border:1px solid var(--border-color); text-align:center;">${c}</code>`).join('')}
            </div>
            <button onclick="copyBackupCodes()" class="btn btn-sm btn-secondary" style="padding:0.3rem 0.75rem;">📋 Copy All Codes</button>
        `;
        container.style.display = 'block';
        window.copyBackupCodes = () => {
            window.copyToClipboard(codes.join('\n'), 'Backup codes copied to clipboard');
        };
    }

    // ── Theme Toggle & Gallery ───────────────────────────────────────────────

    function initThemeToggle() {
        const themeBtn = document.getElementById('settings-theme-toggle-btn');
        if (themeBtn) {
            // Standalone fallback if PulseOpsApp is absent
            if (!window.PulseOpsApp) {
                themeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const current = localStorage.getItem('pulseops-theme') || 'dark';
                    applyTheme(current === 'dark' ? 'light' : 'dark');
                });
            }
        }

        // Theme Gallery tile clicks
        document.querySelectorAll('.theme-card-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                const themeId = tile.dataset.themeId;
                if (!themeId) return;
                applyTheme(themeId);
                const title = tile.querySelector('.theme-card-title')?.textContent || themeId;
                showToast(`Theme switched to ${title}`, 'success', 2000);
            });
        });

        // Listen for global theme changes to keep button & gallery tiles synced
        document.addEventListener('pulseops:theme:changed', (e) => {
            const theme = e.detail?.theme || 'dark';
            const btn = document.getElementById('settings-theme-toggle-btn');
            if (btn) btn.textContent = theme === 'light' ? '🌙 Switch to Dark Mode' : '☀️ Switch to Light Mode';
            syncThemeGallery(theme);
        });

        const current = localStorage.getItem('pulseops-theme') || 'dark';
        applyTheme(current);
        syncThemeGallery(current);
    }

    function syncThemeGallery(theme) {
        document.querySelectorAll('.theme-card-tile').forEach(tile => {
            const isMatch = tile.dataset.themeId === theme;
            tile.classList.toggle('active', isMatch);
            const badge = tile.querySelector('.theme-card-badge');
            if (badge) badge.textContent = isMatch ? 'Active' : 'Select';
        });
    }

    function applyTheme(theme) {
        if (window.PulseOpsApp && typeof window.PulseOpsApp.applyTheme === 'function') {
            window.PulseOpsApp.applyTheme(theme);
        } else {
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('pulseops-theme', theme);
            const btn = document.getElementById('settings-theme-toggle-btn');
            if (btn) btn.textContent = theme === 'light' ? '🌙 Switch to Dark Mode' : '☀️ Switch to Light Mode';
            syncThemeGallery(theme);
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        // Save section buttons
        document.querySelectorAll('[data-save-section]').forEach(btn => {
            btn.addEventListener('click', () => saveSection(btn.dataset.saveSection));
        });

        // Save all button
        const saveAllBtn = document.getElementById('btn-save-all-settings');
        if (saveAllBtn) saveAllBtn.addEventListener('click', saveAll);

        // Webhook test
        const webhookBtn = document.getElementById('test-webhook-btn');
        if (webhookBtn) webhookBtn.addEventListener('click', testWebhook);

        // SMTP test
        const smtpBtn = document.getElementById('test-smtp-btn');
        if (smtpBtn) smtpBtn.addEventListener('click', testSMTP);

        // Database actions
        const vacuumBtn = document.getElementById('btn-db-vacuum');
        if (vacuumBtn) vacuumBtn.addEventListener('click', vacuumDatabase);

        const purgeBtn = document.getElementById('btn-db-purge');
        if (purgeBtn) purgeBtn.addEventListener('click', purgeMetrics);

        const resetBtn = document.getElementById('btn-reset-defaults');
        if (resetBtn) resetBtn.addEventListener('click', resetDefaults);

        const backupBtn = document.getElementById('backup-db-btn');
        if (backupBtn) backupBtn.addEventListener('click', downloadBackup);

        const restoreBtn = document.getElementById('restore-db-btn');
        if (restoreBtn) restoreBtn.addEventListener('click', triggerRestore);

        const restoreInput = document.getElementById('db-restore-file-input');
        if (restoreInput) restoreInput.addEventListener('change', handleRestoreFile);

        const refreshSettingsBtn = document.getElementById('btn-refresh-settings');
        if (refreshSettingsBtn) refreshSettingsBtn.addEventListener('click', () => {
            loadSettings();
            showToast('Settings reloaded from database', 'info', 2000);
        });

        // 2FA
        const setup2faBtn = document.getElementById('setup-2fa-btn');
        if (setup2faBtn) setup2faBtn.addEventListener('click', setup2FA);

        const verify2faBtn = document.getElementById('verify-2fa-btn');
        if (verify2faBtn) verify2faBtn.addEventListener('click', verify2FA);

        // Category navigation & quick search & dirty tracking
        initCategoryNav();
        initSearch();
        initDirtyTracking();

        // Theme toggle
        initThemeToggle();

        // Load initial settings
        loadSettings();
    }

    const api = {
        init,
        loadSettings,
        saveSection,
        saveAll,
        applyTheme,
        loadDatabaseStats,
        vacuumDatabase
    };
    window.SettingsManager = api;
    return api;
})();
