# Squad Decisions

## Active Decisions

### Decision: Security Vulnerability Fixes (5 Issues)

**Author:** McManus (Security Analyst)  
**Date:** 2025-07-09  
**Status:** Implemented  

#### Context

Post-audit fix priorities identified 5 security vulnerabilities ranging from CRITICAL to MEDIUM severity.

#### Fixes Applied

1. **OAuth CSRF — Predictable state** (CRITICAL)
   - **File:** `server.js`
   - State is now a 64-char hex nonce from `crypto.randomBytes(32)`, stored server-side in `oauthStateStore` Map with 10-min TTL. Callback validates nonce, rejects expired/missing, deletes after use. Cleanup runs every 5 minutes.

2. **MQTT command replay bypass** (HIGH)
   - **File:** `mqtt/command-handler.js`
   - `ts` field is now required. Missing `payload` or `payload.ts` triggers immediate rejection with warning log.

3. **Ring password held in memory** (MEDIUM)
   - **File:** `ring-client.js`
   - `pendingLogin` (containing plaintext password) is auto-cleared after 10 minutes via `setTimeout`. Timer cleared on successful verification or new login attempt.

4. **CSP unsafe-inline in script-src** (MEDIUM)
   - **File:** `server.js`
   - Changed from `script-src 'self' 'unsafe-inline'` to `script-src 'self'` — inline scripts blocked. `style-src 'unsafe-inline'` retained for Fluent UI.

5. **Rate limiting on sensitive endpoints** (MEDIUM)
   - **File:** `server.js`
   - In-memory sliding-window rate limiter using Map of timestamp arrays per IP.
   - Limits: `/api/auth/login` and `/ring/login` at 5 req/60s; `/api/llm/chat` at 20 req/60s.
   - 429 responses with recovery guidance. Expired entries pruned every 60 seconds.

#### Trade-offs

- In-memory stores (oauth nonces, rate limits) reset on server restart — acceptable for this deployment model.
- Rate limiting by `req.ip` may be too aggressive behind shared proxies — monitor and adjust.
- No npm packages added per project convention.

#### Rationale

Focused on security gaps that can be fixed surgically without architectural changes. All critical and high-severity issues resolved.

---

### Decision: Backend Resilience Fixes

**Author:** Fenster (Backend Reviewer)  
**Date:** 2025-01-22

#### Scope

Error handling, retry logic, resource leak prevention.

#### Decisions Made

1. **Trending flush() — write-then-drain**: Buffer is now copied with `.slice(0)` before DB write, and only `.splice()`d after success. On failure, events remain in buffer for next flush retry.

2. **Ring subscription lifecycle**: Token subscription is stored in module-level `tokenSubscription` and `.unsubscribe()`d in `disconnect()`. Prevents accumulation on reconnect cycles.

3. **Ring retry policy**: Read operations (`getAlarmMode`, `getDevices`, `getSensorStatus`) retry up to 3 attempts with 2s delay. Write operations (`setAlarmMode`, `controlSiren`) are NOT retried — fail fast to avoid double arm/disarm. Auth errors are never retried.

4. **Express async error handling**: All async routes without try-catch now have them. Error responses use generic "Internal server error" message to avoid leaking internals. Real errors logged server-side with `[Server]` tag.

5. **Timer cleanup**: `withTimeout` now clears its `setTimeout` via `.finally()` when the original promise wins the race.

6. **Govee start() idempotency**: Concurrent `start()` calls now stop existing timers first via `await this.stop()` before re-initializing.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
