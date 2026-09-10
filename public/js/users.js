/**
 * users.js — PulseOps Enterprise User Management UI
 *
 * Admin-only panel for creating, editing, deactivating, and viewing
 * user accounts. Includes role badge display and password strength meter.
 */

const UsersManager = (() => {
    let _users = [];

    const ROLE_CONFIG = {
        admin:    { label: 'Admin',    cls: 'role-admin',    desc: 'Full access — all operations' },
        operator: { label: 'Operator', cls: 'role-operator', desc: 'Service control, terminal, process management' },
        viewer:   { label: 'Viewer',   cls: 'role-viewer',   desc: 'Read-only — all dashboards' },
    };

    function roleBadge(role) {
        const cfg = ROLE_CONFIG[role] || ROLE_CONFIG.viewer;
        return `<span class="role-badge ${cfg.cls}" title="${cfg.desc}">${cfg.label}</span>`;
    }

    function statusBadge(user) {
        if (!user.is_active) return '<span class="status-badge-sm inactive">Inactive</span>';
        if (user.locked_until && new Date(user.locked_until) > new Date())
            return '<span class="status-badge-sm locked">Locked</span>';
        return '<span class="status-badge-sm active">Active</span>';
    }

    function getInitials(name) {
        return (name || '??').split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase();
    }

    function getAvatarColor(email) {
        let hash = 0;
        for (let c of (email || '')) hash = c.charCodeAt(0) + ((hash << 5) - hash);
        const colors = ['#38bdf8','#818cf8','#a855f7','#22c55e','#f59e0b','#ef4444','#06b6d4'];
        return colors[Math.abs(hash) % colors.length];
    }

    // ── Load Users ────────────────────────────────────────────────────────────

    async function loadUsers() {
        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/users');
            if (!resp || !resp.ok) return;
            _users = await resp.json();
            renderUsersTable();
        } catch (e) {
            console.error('[Users] Load error:', e);
        }
    }

    // ── Render Table ──────────────────────────────────────────────────────────

    function renderUsersTable() {
        const tbody = document.getElementById('users-table-body');
        if (!tbody) return;

        const currentUser = PulseOpsAuth.getUser();

        if (_users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">No users found</td></tr>`;
            return;
        }

        tbody.innerHTML = _users.map(user => {
            const isSelf = currentUser && user.id === currentUser.id;
            const color  = getAvatarColor(user.email);
            const initials = getInitials(user.display_name);
            const lastLogin = user.last_login
                ? new Date(user.last_login).toLocaleDateString() + ' ' + new Date(user.last_login).toLocaleTimeString()
                : 'Never';

            return `
            <tr class="${isSelf ? 'current-user-row' : ''}">
                <td>
                    <div class="user-identity">
                        <div class="user-avatar" style="background:${color};">${initials}</div>
                        <div>
                            <div class="user-display-name">${user.display_name} ${isSelf ? '<span class="self-badge">You</span>' : ''}</div>
                            <div class="user-email">${user.email}</div>
                        </div>
                    </div>
                </td>
                <td>${roleBadge(user.role)}</td>
                <td>${statusBadge(user)}</td>
                <td class="user-last-login">${lastLogin}</td>
                <td>
                    <div class="user-actions">
                        <button class="btn-user-action" data-action="edit" data-user-id="${user.id}" title="Edit user">✏️ Edit</button>
                        ${!isSelf ? `
                        <button class="btn-user-action ${user.is_active ? 'danger' : 'success'}"
                            data-action="${user.is_active ? 'deactivate' : 'activate'}"
                            data-user-id="${user.id}"
                            data-name="${user.display_name}"
                            title="${user.is_active ? 'Deactivate' : 'Reactivate'} user">
                            ${user.is_active ? '🚫 Deactivate' : '✅ Activate'}
                        </button>
                        ` : ''}
                        ${user.locked_until && new Date(user.locked_until) > new Date() ? `
                        <button class="btn-user-action" data-action="unlock" data-user-id="${user.id}" title="Unlock account">🔓 Unlock</button>
                        ` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');

        // Attach action listeners
        tbody.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => handleUserAction(btn.dataset.action, btn));
        });

        // Update stats
        const el = document.getElementById('user-count-total');
        if (el) el.textContent = _users.length;
        const admins = document.getElementById('user-count-admins');
        if (admins) admins.textContent = _users.filter(u => u.role === 'admin').length;
        const active = document.getElementById('user-count-active');
        if (active) active.textContent = _users.filter(u => u.is_active).length;
    }

    async function handleUserAction(action, btn) {
        const userId = parseInt(btn.dataset.userId);
        const name   = btn.dataset.name || '';

        if (action === 'edit') {
            openEditUserModal(userId);
        } else if (action === 'deactivate') {
            if (!confirm(`Deactivate user "${name}"? They will be logged out on their next request.`)) return;
            await updateUser(userId, { is_active: false });
            showToast(`User "${name}" deactivated`, 'warning');
        } else if (action === 'activate') {
            await updateUser(userId, { is_active: true });
            showToast(`User "${name}" reactivated`, 'success');
        } else if (action === 'unlock') {
            await updateUser(userId, { unlock: true });
            showToast(`Account unlocked`, 'success');
        }
    }

    // ── Create User ───────────────────────────────────────────────────────────

    function openCreateUserModal() {
        const modal = document.getElementById('create-user-modal');
        if (!modal) return;
        document.getElementById('new-user-email').value        = '';
        document.getElementById('new-user-displayname').value  = '';
        document.getElementById('new-user-password').value     = '';
        document.getElementById('new-user-role').value         = 'viewer';
        updatePasswordStrength('');
        modal.style.display = 'flex';
    }

    async function submitCreateUser() {
        const email        = document.getElementById('new-user-email').value.trim();
        const display_name = document.getElementById('new-user-displayname').value.trim();
        const password     = document.getElementById('new-user-password').value;
        const role         = document.getElementById('new-user-role').value;

        if (!email || !display_name || !password) {
            showToast('All fields are required', 'error'); return;
        }

        const btn = document.getElementById('create-user-submit-btn');
        btn.disabled = true; btn.textContent = 'Creating...';

        try {
            const resp = await PulseOpsAuth.apiFetch('/api/admin/users', {
                method: 'POST',
                body: JSON.stringify({ email, display_name, password, role }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                showToast(`User "${display_name}" created`, 'success');
                document.getElementById('create-user-modal').style.display = 'none';
                loadUsers();
            } else {
                showToast(data.detail || data.error || 'Failed to create user', 'error');
            }
        } catch { showToast('Network error', 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Create User'; }
    }

    // ── Edit User ─────────────────────────────────────────────────────────────

    function openEditUserModal(userId) {
        const user = _users.find(u => u.id === userId);
        if (!user) return;
        const modal = document.getElementById('edit-user-modal');
        if (!modal) return;

        document.getElementById('edit-user-id').value          = userId;
        document.getElementById('edit-user-email').value       = user.email;
        document.getElementById('edit-user-displayname').value = user.display_name;
        document.getElementById('edit-user-role').value        = user.role;
        document.getElementById('edit-user-active').checked    = !!user.is_active;
        document.getElementById('edit-user-password').value    = '';
        modal.style.display = 'flex';
    }

    async function submitEditUser() {
        const userId       = parseInt(document.getElementById('edit-user-id').value);
        const email        = document.getElementById('edit-user-email').value.trim();
        const display_name = document.getElementById('edit-user-displayname').value.trim();
        const role         = document.getElementById('edit-user-role').value;
        const is_active    = document.getElementById('edit-user-active').checked;
        const password     = document.getElementById('edit-user-password').value;

        const payload = { email, display_name, role, is_active };
        if (password) payload.password = password;

        await updateUser(userId, payload);
        document.getElementById('edit-user-modal').style.display = 'none';
    }

    async function updateUser(userId, updates) {
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/admin/users/${userId}`, {
                method: 'PUT',
                body: JSON.stringify(updates),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                loadUsers();
                return true;
            } else {
                showToast(data.detail || data.error || 'Update failed', 'error');
                return false;
            }
        } catch { showToast('Network error', 'error'); return false; }
    }

    // ── Password Strength Meter ───────────────────────────────────────────────

    function updatePasswordStrength(password) {
        const bar   = document.getElementById('password-strength-bar');
        const label = document.getElementById('password-strength-label');
        if (!bar || !label) return;

        let score = 0;
        if (password.length >= 8)   score++;
        if (password.length >= 12)  score++;
        if (/[A-Z]/.test(password)) score++;
        if (/[0-9]/.test(password)) score++;
        if (/[^A-Za-z0-9]/.test(password)) score++;

        const levels = [
            { label: '',         pct: 0,   color: 'transparent' },
            { label: 'Weak',     pct: 20,  color: '#ef4444' },
            { label: 'Fair',     pct: 40,  color: '#f97316' },
            { label: 'Good',     pct: 60,  color: '#f59e0b' },
            { label: 'Strong',   pct: 80,  color: '#22c55e' },
            { label: 'Very Strong', pct: 100, color: '#38bdf8' },
        ];

        const level = levels[Math.min(score, 5)];
        bar.style.width  = level.pct + '%';
        bar.style.background = level.color;
        label.textContent = level.label;
        label.style.color = level.color;
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        // Create user button
        const createBtn = document.getElementById('create-user-btn');
        if (createBtn) createBtn.addEventListener('click', openCreateUserModal);

        // Submit create form
        const createSubmit = document.getElementById('create-user-submit-btn');
        if (createSubmit) createSubmit.addEventListener('click', submitCreateUser);

        // Submit edit form
        const editSubmit = document.getElementById('edit-user-submit-btn');
        if (editSubmit) editSubmit.addEventListener('click', submitEditUser);

        // Password strength meter
        const pwInput = document.getElementById('new-user-password');
        if (pwInput) pwInput.addEventListener('input', () => updatePasswordStrength(pwInput.value));

        // Modal close
        document.querySelectorAll('[data-close-modal]').forEach(btn => {
            btn.addEventListener('click', () => {
                const modal = document.getElementById(btn.dataset.closeModal);
                if (modal) modal.style.display = 'none';
            });
        });

        // Search/filter
        const searchInput = document.getElementById('user-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', () => filterUsers(searchInput.value));
        }

        const roleFilter = document.getElementById('user-role-filter');
        if (roleFilter) {
            roleFilter.addEventListener('change', () => filterUsers('', roleFilter.value));
        }

        loadUsers();
    }

    function filterUsers(query = '', role = '') {
        const tbody = document.getElementById('users-table-body');
        if (!tbody) return;
        const rows = tbody.querySelectorAll('tr');
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            const matchQuery = !query || text.includes(query.toLowerCase());
            const matchRole  = !role  || text.includes(role.toLowerCase());
            row.style.display = (matchQuery && matchRole) ? '' : 'none';
        });
    }

    return {
        init,
        loadUsers,
        renderUsersTable,
    };
})();
