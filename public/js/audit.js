/**
 * audit.js — PulseOps Enterprise Audit Log Viewer
 *
 * Paginated, filterable audit log table with CSV export,
 * action type coloring, and date range filtering.
 */

const AuditViewer = (() => {
    let _currentPage    = 1;
    let _pageSize       = 50;
    let _totalPages     = 1;
    let _filters        = {};
    let _isLoading      = false;

    // ── Action Color Coding ───────────────────────────────────────────────────

    const ACTION_COLORS = {
        'auth.login':        '#22c55e',
        'auth.logout':       '#94a3b8',
        'auth.login.fail':   '#ef4444',
        'user.create':       '#38bdf8',
        'user.update':       '#f59e0b',
        'user.deactivate':   '#ef4444',
        'fleet.server.add':  '#38bdf8',
        'fleet.server.remove': '#ef4444',
        'service.start':     '#22c55e',
        'service.stop':      '#ef4444',
        'service.restart':   '#f59e0b',
        'process.kill':      '#ef4444',
        'terminal.exec':     '#a855f7',
        'settings.update':   '#f59e0b',
    };

    function getActionColor(action) {
        for (const [key, color] of Object.entries(ACTION_COLORS)) {
            if (action.includes(key)) return color;
        }
        return '#94a3b8';
    }

    function resultBadge(result) {
        return result === 'failure'
            ? '<span class="audit-result-fail">✗ Failure</span>'
            : '<span class="audit-result-ok">✓ Success</span>';
    }

    // ── Load Audit Log ────────────────────────────────────────────────────────

    async function loadAuditLog(page = 1) {
        if (_isLoading) return;
        _isLoading  = true;
        _currentPage = page;

        const params = new URLSearchParams({
            page:      page,
            page_size: _pageSize,
            ..._filters,
        });
        // Remove empty filters
        for (const [k, v] of [...params.entries()]) {
            if (!v) params.delete(k);
        }

        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/admin/audit?${params.toString()}`);
            if (!resp || !resp.ok) return;
            const data = await resp.json();
            _totalPages = data.pages || 1;
            renderAuditTable(data.entries, data.total);
            renderPagination(data.total);
        } catch (e) {
            console.error('[Audit] Load error:', e);
        } finally {
            _isLoading = false;
        }
    }

    // ── Render Table ──────────────────────────────────────────────────────────

    function renderAuditTable(entries, total) {
        const tbody = document.getElementById('audit-table-body');
        if (!tbody) return;

        const totalEl = document.getElementById('audit-total-count');
        if (totalEl) totalEl.textContent = total;

        if (!entries || entries.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-table-cell">No audit log entries found</td></tr>`;
            return;
        }

        tbody.innerHTML = entries.map(entry => {
            const ts      = new Date(entry.timestamp);
            const date    = ts.toLocaleDateString();
            const time    = ts.toLocaleTimeString();
            const color   = getActionColor(entry.action || '');
            const details = entry.details && typeof entry.details === 'object'
                ? Object.entries(entry.details).map(([k, v]) => `<span class="audit-detail-kv"><b>${k}</b>: ${JSON.stringify(v)}</span>`).join(' ')
                : (entry.details || '—');

            return `
            <tr>
                <td class="audit-ts">
                    <div>${date}</div>
                    <div class="audit-ts-time">${time}</div>
                </td>
                <td>
                    <div class="audit-user">${entry.user_email || '<span style="color:var(--text-dim)">System</span>'}</div>
                </td>
                <td>
                    <span class="audit-action" style="color:${color};">${entry.action || '—'}</span>
                </td>
                <td>${entry.resource_type || '—'}</td>
                <td class="audit-resource-id">${entry.resource_id || '—'}</td>
                <td class="audit-details-cell">${details}</td>
                <td>${resultBadge(entry.result)}</td>
            </tr>`;
        }).join('');
    }

    // ── Pagination ────────────────────────────────────────────────────────────

    function renderPagination(total) {
        const container = document.getElementById('audit-pagination');
        if (!container) return;

        const pages = Math.ceil(total / _pageSize);
        if (pages <= 1) { container.innerHTML = ''; return; }

        let html = '';
        html += `<button class="page-btn" ${_currentPage === 1 ? 'disabled' : ''} onclick="AuditViewer.goToPage(${_currentPage - 1})">← Prev</button>`;

        // Show window of pages around current
        const start = Math.max(1, _currentPage - 2);
        const end   = Math.min(pages, _currentPage + 2);
        if (start > 1)   html += `<button class="page-btn" onclick="AuditViewer.goToPage(1)">1</button>${start > 2 ? '<span class="page-ellipsis">…</span>' : ''}`;
        for (let p = start; p <= end; p++) {
            html += `<button class="page-btn ${p === _currentPage ? 'active' : ''}" onclick="AuditViewer.goToPage(${p})">${p}</button>`;
        }
        if (end < pages) html += `${end < pages - 1 ? '<span class="page-ellipsis">…</span>' : ''}<button class="page-btn" onclick="AuditViewer.goToPage(${pages})">${pages}</button>`;

        html += `<button class="page-btn" ${_currentPage === pages ? 'disabled' : ''} onclick="AuditViewer.goToPage(${_currentPage + 1})">Next →</button>`;
        html += `<span class="page-info">Page ${_currentPage} of ${pages} (${total} entries)</span>`;
        container.innerHTML = html;
    }

    function goToPage(page) {
        if (page < 1 || page > _totalPages) return;
        loadAuditLog(page);
    }

    // ── CSV Export ────────────────────────────────────────────────────────────

    async function exportCSV() {
        const params = new URLSearchParams({ page: 1, page_size: 5000, ..._filters });
        try {
            const resp = await PulseOpsAuth.apiFetch(`/api/admin/audit?${params.toString()}`);
            if (!resp || !resp.ok) return;
            const data = await resp.json();
            const entries = data.entries || [];

            const headers = ['Timestamp', 'User Email', 'Action', 'Resource Type', 'Resource ID', 'Details', 'Result', 'IP Address'];
            const rows = entries.map(e => [
                e.timestamp, e.user_email || '', e.action || '', e.resource_type || '',
                e.resource_id || '', JSON.stringify(e.details || ''), e.result || '', e.ip_address || '',
            ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

            const csv = [headers.join(','), ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `pulseops-audit-${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            showToast('Failed to export audit log', 'error');
        }
    }

    // ── Filters ───────────────────────────────────────────────────────────────

    function applyFilters() {
        _filters = {
            user_filter:    document.getElementById('audit-filter-user')?.value.trim() || '',
            action_filter:  document.getElementById('audit-filter-action')?.value.trim() || '',
            resource_type:  document.getElementById('audit-filter-resource')?.value || '',
            result_filter:  document.getElementById('audit-filter-result')?.value || '',
            date_from:      document.getElementById('audit-filter-from')?.value || '',
            date_to:        document.getElementById('audit-filter-to')?.value || '',
        };
        loadAuditLog(1);
    }

    function clearFilters() {
        ['audit-filter-user', 'audit-filter-action', 'audit-filter-resource',
         'audit-filter-result', 'audit-filter-from', 'audit-filter-to'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        _filters = {};
        loadAuditLog(1);
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        const applyBtn = document.getElementById('audit-filter-apply-btn');
        if (applyBtn) applyBtn.addEventListener('click', applyFilters);

        const clearBtn = document.getElementById('audit-filter-clear-btn');
        if (clearBtn) clearBtn.addEventListener('click', clearFilters);

        const exportBtn = document.getElementById('audit-export-btn');
        if (exportBtn) exportBtn.addEventListener('click', exportCSV);

        // Auto-apply on Enter key in filter inputs
        document.querySelectorAll('.audit-filter-input').forEach(inp => {
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
        });

        loadAuditLog(1);

        // Auto-refresh every 60s
        setInterval(() => loadAuditLog(_currentPage), 60000);
    }

    const api = {
        init,
        loadAuditLog,
        goToPage,
        exportCSV,
    };
    window.AuditViewer = api;
    return api;
})();
