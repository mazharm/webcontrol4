# Keyser — History

## Core Context

- **Project:** Comprehensive reliability and security audit of a Node.js home automation system
- **Role:** Lead
- **Joined:** 2026-04-02T19:35:28.495Z

## Learnings

<!-- Append learnings below -->

### 2026-04-02 — Full Codebase Audit

**Architecture understanding:**
- Monolithic `server.js` (~2600 lines) is the core, contains Express app, auth, LLM integration, realtime engine, and all REST routes.
- Real-time pipeline: C4WebSocket → StateMachine → SSE broadcast + Trending DB + MQTT publish.
- MQTT module (`mqtt/`) is well-decomposed: mqtt-client, state-publisher, command-handler, rpc-handler, device-map.
- `http-client.js` provides the outbound HTTP foundation with SSRF protection and redirect filtering.
- `oauth.js` handles both web-app Google OAuth sessions and MCP OAuth2 AS (PKCE). All in-memory, lost on restart.
- `ring-client.js` uses ring-client-api library, wraps with thin REST API + email/password 2FA flow.
- `govee-leak.js` is self-contained poll-based cloud API client with token management and backoff.

**Key file paths:**
- Settings: `data/settings.json` (0o600 perms)
- Routines: `data/routines.json`
- Trending DB: `data/trending.db` (SQLite WAL)
- Ring token: `.env` (RING_REFRESH_TOKEN)
- TLS certs: `certs/` (auto-generated self-signed if needed)

**Patterns observed:**
- Graceful shutdown via SIGTERM/SIGINT covers MQTT, Govee, Trending, C4WS, Ring.
- `unhandledRejection` handler prevents crash (added recently).
- Input validation is thorough on REST endpoints (length limits, type checks, allowlists).
- SSRF protection via `isPrivateOrLocalHost()` for Director proxy and redirect following.
- Condition engine for routines has proper cooldown and duration tracking.

**Remaining risks identified (sorted by severity):**
- Predictable OAuth state (CSRF) in web app Google OAuth flow.
- Trending flush() splices buffer before confirming write — data loss on DB error.
- Ring subscription leak on token refresh (onRefreshTokenUpdated never unsubscribed).
- No rate limiting on authentication or LLM endpoints.
- Missing try-catch on several Ring route handlers in Express 4 (async handler pattern).
- MQTT command replay protection can be bypassed by omitting timestamp.
- CSP still has unsafe-inline for scripts/styles.
