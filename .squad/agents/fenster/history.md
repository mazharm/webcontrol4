# Fenster — History

## Core Context

- **Project:** Comprehensive reliability and security audit of a Node.js home automation system
- **Role:** Backend Reviewer
- **Joined:** 2026-04-02T19:35:28.500Z

## Learnings

- `trending.js` flush() uses better-sqlite3 synchronous transactions; buffer must only be drained after confirmed write success.
- `ring-client.js` uses RxJS-style `.subscribe()` returning a subscription object — must store and `.unsubscribe()` on disconnect to avoid leaks.
- Ring read operations (`getAlarmMode`, `getDevices`, `getSensorStatus`) are safe to retry; write operations (`setAlarmMode`, `controlSiren`) must fail fast.
- Express 4 does not handle async route rejections — every async handler needs explicit try-catch. Routes at `/ring/login`, `/ring/verify`, `/ring/status`, `/notify/test`, `/notify/send` were unprotected.
- `withTimeout` using `Promise.race` leaks `setTimeout` handles; `.finally(() => clearTimeout(timer))` is the standard fix.
- `govee-leak.js` `start()` can be called concurrently; guard with `if (this._running) await this.stop()` to prevent duplicate poll timers.
- Key file paths: `trending.js`, `ring-client.js`, `server.js` (lines ~1800-1990 for Ring/notify routes), `govee-leak.js`.
