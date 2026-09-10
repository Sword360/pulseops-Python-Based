/**
 * settings.js — PulseOps Enterprise System Settings Panel
 *
 * Loads and saves all system settings from the /api/admin/settings endpoint.
 * Includes SMTP test, DB backup/restore, and 2FA enrollment.
 */

const SettingsManager = (() => {
    let _settings = {};

    // ── Load Settings ─────────────────────────────────────────────────────────

    async function loadSettings() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings');
            if (!resp || !resp.ok) return;
            _settings = await resp.json();
            populateForm();
        } catch (e) {
            console.error('[Settings] Load error:', e);
        }
    }

    // ── Populate Form Fields ──────────────────────────────────────────────────

    function populateForm() {
        const map = {
            'setting-app-name':           'app_name',
            'setting-session-timeout':    'session_timeout_hours',
            'setting-agent-poll':         'agent_poll_interval',
            'setting-snapshot-retention': 'snapshot_retention_hours',
            'setting-cpu-threshold':      'global_cpu_alert_threshold',
            'setting-mem-threshold':      'global_mem_alert_threshold',
            'setting-disk-threshold':     'global_disk_alert_threshold',
            'setting-smtp-host':          'smtp_host',
            'setting-smtp-port':          'smtp_port',
            'setting-smtp-username':      'smtp_username',
            'setting-smtp-from':          'smtp_from',
            'setting-master-url':         'master_url',
        };
        for (const [elId, key] of Object.entries(map)) {
            const el = document.getElementById(elId);
            if (el) el.value = _settings[key] || '';
        }
        // Boolean toggles
        const require2fa = document.getElementById('setting-require-2fa');
        if (require2fa) require2fa.checked = _settings.require_2fa === 'true';
    }

    // ── Save Settings Section ─────────────────────────────────────────────────

    async function saveSection(sectionId) {
        const section  = document.getElementById(sectionId);
        if (!section) return;

        const payload = {};
        section.querySelectorAll('[data-setting-key]').forEach(el => {
            const key = el.dataset.settingKey;
            if (el.type === 'checkbox') {
                payload[key] = String(el.checked);
            } else {
                const val = el.value.trim();
                // Don't overwrite masked passwords
                if (val !== '••••••••') payload[key] = val;
            }
        });

        const btn = section.querySelector('[data-save-section]');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings', {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`Settings saved (${data.updated_count} fields)`, 'success');
                Object.assign(_settings, payload);
            } else {
                showToast(data.detail || 'Save failed', 'error');
            }
        } catch { showToast('Network error', 'error'); }
        finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
        }
    }

    // ── SMTP Test ─────────────────────────────────────────────────────────────

    async function testSMTP() {
        const btn    = document.getElementById('test-smtp-btn');
        const result = document.getElementById('smtp-test-result');
        if (btn) { btn.disabled = true; btn.textContent = 'Sending test...'; }
        if (result) { result.textContent = ''; result.style.display = 'none'; }

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/settings/test-smtp', { method: 'POST' });
            if (resp && resp.ok) {
                if (result) {
                    result.textContent = '✅ Test email sent successfully';
                    result.className = 'smtp-test-result success';
                    result.style.display = 'block';
                }
            } else {
                const data = await resp.json().catch(() => ({}));
                if (result) {
                    result.textContent = `❌ ${data.detail || 'Test failed — check SMTP settings'}`;
                    result.className = 'smtp-test-result error';
                    result.style.display = 'block';
                }
            }
        } catch {
            if (result) {
                result.textContent = '❌ Network error — cannot reach server';
                result.className = 'smtp-test-result error';
                result.style.display = 'block';
            }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '📧 Test SMTP'; }
        }
    }

    // ── Database Backup ───────────────────────────────────────────────────────

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
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `pulseops-backup-${new Date().toISOString().split('T')[0]}.db`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Database backup downloaded', 'success');
        } catch { showToast('Backup download failed', 'error'); }
        finally {
            if (btn) { btn.disabled = false; btn.textContent = '💾 Download Backup'; }
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

            // Show QR code and backup codes
            const panel = document.getElementById('2fa-setup-panel');
            if (panel) {
                document.getElementById('2fa-secret-display').textContent = data.secret || '';
                document.getElementById('2fa-otpauth-uri').textContent     = data.otpauth_uri || '';
                if (data.qr_data_url) {
                    const img = document.getElementById('2fa-qr-img');
                    if (img) { img.src = data.qr_data_url; img.style.display = 'block'; }
                }
                panel.style.display = 'block';
            }
        } catch { showToast('Failed to initialize 2FA', 'error'); }
        finally { if (btn) { btn.disabled = false; btn.textContent = '🔐 Setup 2FA'; } }
    }

    async function verify2FA() {
        const code = document.getElementById('2fa-verify-code')?.value.trim();
        if (!code || code.length !== 6) { showToast('Enter a 6-digit code', 'error'); return; }

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
                document.getElementById('2fa-status-text').textContent = '✅ 2FA Enabled';
                if (data.backup_codes) {
                    renderBackupCodes(data.backup_codes);
                }
            } else {
                showToast(data.detail || 'Invalid code', 'error');
            }
        } catch { showToast('Verification failed', 'error'); }
        finally { if (btn) { btn.disabled = false; } }
    }

    function renderBackupCodes(codes) {
        const container = document.getElementById('backup-codes-container');
        if (!container || !codes) return;
        container.innerHTML = `
            <div class="backup-codes-header">🔑 Save these backup codes — they can only be shown once:</div>
            <div class="backup-codes-grid">
                ${codes.map(c => `<code class="backup-code">${c}</code>`).join('')}
            </div>
            <button onclick="copyBackupCodes()" class="btn-small">Copy All Codes</button>
        `;
        container.style.display = 'block';
        window.copyBackupCodes = () => {
            navigator.clipboard.writeText(codes.join('\n')).then(() => showToast('Backup codes copied', 'success'));
        };
    }

    // ── Theme Toggle ──────────────────────────────────────────────────────────

    function initThemeToggle() {
        const toggle  = document.getElementById('theme-toggle-btn');
        const current = localStorage.getItem('pulseops-theme') || 'dark';
        applyTheme(current);

        if (toggle) {
            toggle.textContent = current === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
            toggle.addEventListener('click', () => {
                const next = localStorage.getItem('pulseops-theme') === 'dark' ? 'light' : 'dark';
                localStorage.setItem('pulseops-theme', next);
                applyTheme(next);
                toggle.textContent = next === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
                showToast(`${next === 'dark' ? 'Dark' : 'Light'} theme applied`, 'info');
            });
        }
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        // Save section buttons
        document.querySelectorAll('[data-save-section]').forEach(btn => {
            btn.addEventListener('click', () => saveSection(btn.dataset.saveSection));
        });

        // SMTP test
        const smtpBtn = document.getElementById('test-smtp-btn');
        if (smtpBtn) smtpBtn.addEventListener('click', testSMTP);

        // Backup
        const backupBtn = document.getElementById('backup-db-btn');
        if (backupBtn) backupBtn.addEventListener('click', downloadBackup);

        // 2FA
        const setup2faBtn = document.getElementById('setup-2fa-btn');
        if (setup2faBtn) setup2faBtn.addEventListener('click', setup2FA);

        const verify2faBtn = document.getElementById('verify-2fa-btn');
        if (verify2faBtn) verify2faBtn.addEventListener('click', verify2FA);

        // Theme toggle
        initThemeToggle();

        // Load settings
        loadSettings();
    }

    return {
        init,
        loadSettings,
        saveSection,
        applyTheme,
    };
})();
