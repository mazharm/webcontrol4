# McManus — History

## Core Context

- **Project:** Comprehensive reliability and security audit of a Node.js home automation system
- **Role:** Security Analyst
- **Joined:** 2026-04-02T19:35:28.498Z

## Learnings

<!-- Append learnings below -->

### 2025-07-09 — Security Vulnerability Fixes (5 issues)

**Files modified:** `server.js`, `mqtt/command-handler.js`, `ring-client.js`

1. **OAuth CSRF (CRITICAL):** Replaced predictable `web:` state parameter with `crypto.randomBytes(32)` nonce stored in a `Map` with 10-min TTL. Callback validates nonce existence and expiry before granting session. Periodic cleanup every 5 minutes.

2. **MQTT command replay bypass (HIGH):** Made `ts` field mandatory in `mqtt/command-handler.js`. Commands without `payload.ts` are now rejected immediately instead of bypassing replay protection.

3. **Ring password memory retention (MEDIUM):** Added `pendingLoginTimer` with 10-min TTL to auto-clear `pendingLogin` credentials. Timer is cleared on successful 2FA verification or direct login.

4. **CSP unsafe-inline (MEDIUM):** Removed `'unsafe-inline'` from `script-src` in CSP header. Kept it in `style-src` for Fluent UI compatibility.

5. **Rate limiting (MEDIUM):** Implemented in-memory sliding-window rate limiter via `rateLimit(maxRequests, windowMs)` factory. Applied 5req/60s to `/api/auth/login` and `/ring/login`, 20req/60s to `/api/llm/chat`. Periodic store cleanup every 60s.

**Patterns:** Map-based stores with TTL cleanup via `setInterval`. Express middleware factory pattern for rate limiting. No npm packages added.
