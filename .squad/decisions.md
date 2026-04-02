# Squad Decisions

## Active Decisions

### Decision: Post-Audit Fix Priorities

**Author:** Keyser (Lead/Architect)  
**Date:** 2026-04-02  
**Context:** Comprehensive codebase audit completed

#### Decision

The following fixes should be prioritized in order:

1. **Trending flush() data loss** — Splice buffer AFTER successful write, not before. Immediate fix, ~5 lines.
2. **OAuth state CSRF** — Add random nonce to web app OAuth state parameter and validate on callback. ~20 lines.
3. **MQTT command replay bypass** — Require `ts` field on commands, reject if missing. ~3 lines.
4. **Ring route handler error safety** — Add try-catch to `/ring/login` and `/ring/verify` handlers. ~10 lines.
5. **Ring subscription cleanup** — Store and unsubscribe `onRefreshTokenUpdated` in `disconnect()`. ~5 lines.

Lower priority (medium/nice-to-have):
- CSP unsafe-inline removal (requires build tooling changes)
- Rate limiting on auth/LLM endpoints (new middleware)
- Ring API retry logic (wrap operations with retry helper)

#### Rationale

Focused on data-loss and security gaps that can be fixed surgically without architectural changes.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
