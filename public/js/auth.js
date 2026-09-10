/**
 * auth.js — PulseOps Enterprise Authentication Client
 *
 * Handles JWT token storage/retrieval, auto-refresh, auth guard,
 * and exposes PulseOpsAuth as a global utility object.
 */

const PulseOpsAuth = (() => {
    const ACCESS_TOKEN_KEY  = 'pulseops_access_token';
    const REFRESH_TOKEN_KEY = 'pulseops_refresh_token';
    const USER_KEY          = 'pulseops_user';

    let _refreshTimer = null;

    // ── Token Storage ─────────────────────────────────────────────────────────

    function saveTokens(accessToken, refreshToken, user) {
        localStorage.setItem(ACCESS_TOKEN_KEY,  accessToken);
        localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
        localStorage.setItem(USER_KEY, JSON.stringify(user));
    }

    function getAccessToken() {
        return localStorage.getItem(ACCESS_TOKEN_KEY);
    }

    function getRefreshToken() {
        return localStorage.getItem(REFRESH_TOKEN_KEY);
    }

    function getUser() {
        try {
            return JSON.parse(localStorage.getItem(USER_KEY)) || null;
        } catch { return null; }
    }

    function clearTokens() {
        localStorage.removeItem(ACCESS_TOKEN_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        if (_refreshTimer) clearTimeout(_refreshTimer);
    }

    // ── JWT Decode (client-side, no verification) ─────────────────────────────

    function decodeJwt(token) {
        try {
            const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const json = atob(base64);
            return JSON.parse(json);
        } catch { return null; }
    }

    function getTokenExpiry(token) {
        const payload = decodeJwt(token);
        return payload ? payload.exp * 1000 : 0; // ms
    }

    // ── Token Refresh ─────────────────────────────────────────────────────────

    async function refreshAccessToken() {
        const refreshToken = getRefreshToken();
        if (!refreshToken) { redirectToLogin(); return null; }

        try {
            const resp = await fetch('/api/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refreshToken }),
            });
            if (!resp.ok) { redirectToLogin(); return null; }
            const data = await resp.json();
            localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
            scheduleRefresh(data.access_token);
            return data.access_token;
        } catch {
            redirectToLogin();
            return null;
        }
    }

    function scheduleRefresh(token) {
        if (_refreshTimer) clearTimeout(_refreshTimer);
        const expiry  = getTokenExpiry(token);
        const now     = Date.now();
        const delay   = Math.max(0, expiry - now - 5 * 60 * 1000); // 5 min before expiry
        _refreshTimer = setTimeout(() => refreshAccessToken(), delay);
    }

    // ── Auth-guarded Fetch ────────────────────────────────────────────────────

    async function apiFetch(url, options = {}) {
        let token = getAccessToken();

        // If token is nearly expired, refresh first
        if (token) {
            const expiry = getTokenExpiry(token);
            if (Date.now() > expiry - 30_000) {
                token = await refreshAccessToken();
                if (!token) return null;
            }
        }

        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const resp = await fetch(url, { ...options, headers });

        if (resp.status === 401) {
            // Try refresh once
            token = await refreshAccessToken();
            if (!token) return null;
            headers['Authorization'] = `Bearer ${token}`;
            return fetch(url, { ...options, headers });
        }

        return resp;
    }

    // ── Logout ────────────────────────────────────────────────────────────────

    async function logout() {
        try {
            await apiFetch('/api/auth/logout', { method: 'POST' });
        } catch { /* ignore */ }
        clearTokens();
        redirectToLogin();
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    function redirectToLogin() {
        if (!window.location.pathname.startsWith('/login')) {
            window.location.href = '/login';
        }
    }

    // ── Auth Guard ────────────────────────────────────────────────────────────

    async function requireAuth() {
        const token = getAccessToken();
        if (!token) { redirectToLogin(); return null; }

        const expiry = getTokenExpiry(token);
        if (Date.now() > expiry) {
            const newToken = await refreshAccessToken();
            if (!newToken) return null;
        }

        scheduleRefresh(token);

        // Validate token with server
        try {
            const resp = await apiFetch('/api/auth/me');
            if (!resp || !resp.ok) { redirectToLogin(); return null; }
            const user = await resp.json();
            // Update stored user data
            localStorage.setItem(USER_KEY, JSON.stringify(user));
            return user;
        } catch {
            redirectToLogin();
            return null;
        }
    }

    // ── Role Checks ───────────────────────────────────────────────────────────

    function hasRole(...roles) {
        const user = getUser();
        return user && roles.includes(user.role);
    }

    function isAdmin() { return hasRole('admin'); }
    function isOperator() { return hasRole('admin', 'operator'); }
    function isViewer() { return hasRole('admin', 'operator', 'viewer'); }

    // ── Header Helper ─────────────────────────────────────────────────────────

    function getAuthHeader() {
        const token = getAccessToken();
        return token ? { 'Authorization': `Bearer ${token}` } : {};
    }

    // ── WebSocket with Auth ───────────────────────────────────────────────────

    function createAuthWebSocket(path) {
        const token   = getAccessToken();
        const proto   = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url     = `${proto}//${window.location.host}${path}`;
        // Token passed as query param for WS (standard approach)
        const fullUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
        return new WebSocket(fullUrl);
    }

    // Public API
    return {
        saveTokens,
        getAccessToken,
        getRefreshToken,
        getUser,
        clearTokens,
        apiFetch,
        logout,
        requireAuth,
        hasRole,
        isAdmin,
        isOperator,
        isViewer,
        getAuthHeader,
        createAuthWebSocket,
        scheduleRefresh,
        redirectToLogin,
    };
})();

// ── Auto-init on every page ───────────────────────────────────────────────────
// On non-login pages: verify authentication immediately
if (!window.location.pathname.startsWith('/login')) {
    PulseOpsAuth.requireAuth().then(user => {
        if (user) {
            // Fire a custom event for the dashboard to pick up
            document.dispatchEvent(new CustomEvent('pulseops:auth:ready', { detail: user }));
        }
    });
}
