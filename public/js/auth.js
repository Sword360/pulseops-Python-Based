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
        if (user && user.role) {
            document.documentElement.setAttribute('data-role', user.role);
            if (document.body) document.body.setAttribute('data-role', user.role);
        }
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
        document.documentElement.removeAttribute('data-role');
        if (document.body) document.body.removeAttribute('data-role');
        if (_refreshTimer) clearTimeout(_refreshTimer);
    }

    // Pre-apply data-role attribute from storage
    try {
        const _u = getUser();
        if (_u && _u.role) document.documentElement.setAttribute('data-role', _u.role);
    } catch (_) {}

    // ── JWT Decode (client-side, no verification) ─────────────────────────────

    function decodeJwt(token) {
        try {
            if (!token || typeof token !== 'string') return null;
            const parts = token.split('.');
            if (parts.length < 2) return null;
            let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (base64.length % 4 !== 0) {
                base64 += '=';
            }
            const json = atob(base64);
            return JSON.parse(json);
        } catch { return null; }
    }

    function getTokenExpiry(token) {
        const payload = decodeJwt(token);
        return payload && payload.exp ? payload.exp * 1000 : 0; // ms
    }

    // ── Token Refresh ─────────────────────────────────────────────────────────

    let _refreshingPromise = null;

    async function refreshAccessToken() {
        if (_refreshingPromise) return _refreshingPromise;

        _refreshingPromise = (async () => {
            const refreshToken = getRefreshToken();
            if (!refreshToken) {
                clearTokens();
                redirectToLogin();
                return null;
            }

            try {
                const resp = await fetch('/api/auth/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refresh_token: refreshToken }),
                });
                if (!resp.ok) {
                    clearTokens();
                    redirectToLogin();
                    return null;
                }
                const data = await resp.json();
                if (data.access_token) {
                    localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
                    scheduleRefresh(data.access_token);
                    return data.access_token;
                }
                return null;
            } catch (err) {
                console.warn('[Auth] Token refresh network error:', err);
                return null;
            } finally {
                _refreshingPromise = null;
            }
        })();

        return _refreshingPromise;
    }

    function scheduleRefresh(token) {
        if (_refreshTimer) clearTimeout(_refreshTimer);
        const expiry  = getTokenExpiry(token);
        if (!expiry) return;
        const now     = Date.now();
        const delay   = Math.max(0, expiry - now - 5 * 60 * 1000); // 5 min before expiry
        if (delay > 0 && delay < 0x7FFFFFFF) {
            _refreshTimer = setTimeout(() => refreshAccessToken(), delay);
        }
    }

    // ── Auth-guarded Fetch ────────────────────────────────────────────────────

    async function apiFetch(url, options = {}) {
        let token = getAccessToken();

        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        let resp;
        try {
            resp = await fetch(url, { ...options, headers });
        } catch (err) {
            console.warn('[Auth] Fetch failed for', url, err);
            return null;
        }

        if (resp && resp.status === 401) {
            // Try refresh once
            const newToken = await refreshAccessToken();
            if (!newToken) return resp;
            headers['Authorization'] = `Bearer ${newToken}`;
            try {
                return await fetch(url, { ...options, headers });
            } catch {
                return null;
            }
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

    let _authPromise = null;

    async function requireAuth() {
        if (_authPromise) return _authPromise;

        _authPromise = (async () => {
            const token = getAccessToken();
            if (!token) {
                redirectToLogin();
                return null;
            }

            // Validate token directly with server
            try {
                const resp = await apiFetch('/api/auth/me');
                if (!resp || !resp.ok) {
                    clearTokens();
                    redirectToLogin();
                    return null;
                }
                const user = await resp.json();
                localStorage.setItem(USER_KEY, JSON.stringify(user));
                if (user && user.role) {
                    document.documentElement.setAttribute('data-role', user.role);
                    if (document.body) document.body.setAttribute('data-role', user.role);
                }
                scheduleRefresh(token);
                return user;
            } catch (err) {
                console.error('[Auth] Verification error:', err);
                const cached = getUser();
                if (cached) return cached;
                clearTokens();
                redirectToLogin();
                return null;
            } finally {
                _authPromise = null;
            }
        })();

        return _authPromise;
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
window.PulseOpsAuth = PulseOpsAuth;

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
