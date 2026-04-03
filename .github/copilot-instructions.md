# Copilot Instructions — WebControl4

## Build & Run

```bash
npm install          # install server dependencies
npm start            # node server.js — serves on :3443
npm run dev          # node --watch server.js — auto-restart on changes
```

### React Client (client/)

```bash
npm --prefix client install   # install client dependencies
npm --prefix client run build # Vite build → outputs to public-react/
npm --prefix client run dev   # Vite dev server with HMR (proxies /api to :3443)
```

The built `public-react/` directory is committed and served by `server.js` at runtime. Rebuild after any client changes.

### No Tests or Linter

There is no test framework or linter configured. Do not attempt to run `npm test`.

## Architecture

```
Browser  ←SSE→  Express (:3443)  ←REST/WS→  Control4 Director (LAN)
                     │                              │
                     ├── Control4 Cloud API (auth only)
                     ├── Ring API (alarm, cameras)
                     ├── Govee API (leak sensors)
                     ├── Anthropic Claude (LLM chat)
                     ├── Pushover (notifications)
                     ├── MQTT bridge (optional remote access)
                     └── MCP server (STDIO + HTTP transports)
```

### Server-Side (Node.js, no TypeScript, no bundler)

- **server.js** (~2600 lines) — monolithic Express app. Main sections in order:
  1. Settings persistence (`data/settings.json`)
  2. Routines engine + scheduler (`data/routines.json`)
  3. In-memory history (circular buffers, 24h × 10s intervals)
  4. Security headers, auth middleware (Google OAuth or Basic Auth)
  5. Control4 Director proxy with mock mode for demo
  6. LLM integration (Anthropic Claude)
  7. Ring, Govee, Pushover integrations
  8. Realtime engine: C4 WebSocket → state machine → SSE broadcast to clients
  9. MQTT bridge (optional)

- **state-machine.js** — normalized device state + derived home intelligence (home/away/sleeping/entertaining mode, room occupancy, alerts). Emits `stateChange` events.

- **c4-websocket.js** — Socket.IO client for Director push events with token refresh, exponential backoff reconnection, and multi-format event parsing.

- **trending.js** — SQLite analytics (better-sqlite3, WAL mode). Records variable changes, computes daily rollups, detects anomalies via 14-day baseline (>2σ).

- **mcp-server.js** — defines ~25 MCP tools (device control, state queries, trending, Ring, notifications). Shared by both transports:
  - `mcp-stdio.js` — for Claude Desktop (`npm run mcp:stdio`)
  - `mcp-http.js` — standalone HTTP+SSE on port 3001 with PKCE OAuth (`npm run mcp:http`)

- **oauth.js** — Google OAuth sessions + MCP OAuth2 authorization server (PKCE, in-memory, lost on restart).

- **mqtt/** — MQTT bridge module: publishes state to HiveMQ Cloud, handles remote commands, exposes RPC methods.

### Client-Side (client/)

React 18 + TypeScript + Vite + Fluent UI (Microsoft). Key structure:

- `src/App.tsx` — React Router with routes: home, rooms, floors, lights, climate, security, cameras, routines, history, settings
- `src/services/api/` — REST client wrappers for each backend API
- `src/contexts/` — Auth, Device, Theme, Transport, SSE contexts
- `src/hooks/useSSE` — Server-Sent Events for realtime updates
- `src/config/transport` — detects local vs MQTT remote mode
- Build output: `../public-react/` (base path `/webcontrol4/` for MQTT/GitHub Pages mode, `/` otherwise)

## Key Conventions

### Server Patterns

- **Logging** uses bracket-prefixed tags: `[Auth]`, `[Director]`, `[WSS]`, `[MQTT]`, etc.
- **Data files** live in `data/` with `0o600` permissions. Settings are read/written via `loadSettings()`/`saveSettings()`.
- **Director proxy** validates targets with `isPrivateOrLocalHost()` for SSRF protection. All Director calls go through the proxy at `/api/director/*`.
- **Mock mode**: when `MCP_CONTROLLER_IP=mock` or no controller is connected, the server simulates devices with an in-memory `mockState` object. The mock has 18 lights, 2 thermostats, and 7 scenes.
- **Routines** are capped at 200 routines, 100 steps each, with alphanumeric names. Condition-based routines evaluate device state changes with configurable cooldowns.

### State Machine

- State discovery fetches all Director categories (lights, thermostats, locks, sensors, security, comfort, media) — do NOT filter by `item.type`.
- Initial state is read in batches of 10 concurrent API calls.
- Home mode is derived: away (no lights + no motion + 60m inactive) → sleeping (night + few lights) → entertaining (3+ rooms + 4+ lights) → home.

### Client Patterns

- Components use Fluent UI v9 (`@fluentui/react-components`)
- Device data flows through `DeviceContext` which merges Control4 + Ring + Govee devices via `utils/deviceMapping`
- Realtime updates arrive via SSE (`useSSE` hook) or MQTT depending on transport mode

### Data Persistence

| What | Where | Notes |
|------|-------|-------|
| User settings / API keys | `data/settings.json` | JSON, 0o600 perms |
| Routines | `data/routines.json` | JSON, validated on load |
| Trending analytics | `data/trending.db` | SQLite WAL, 30-day raw retention |
| Device history | In-memory | Circular buffer, 8640 points/key, max 5000 keys |
| Auth sessions | In-memory | Lost on restart |

### Environment

All env vars are optional. Key groups (see `.env.example` for full list):
- `PORT` / `HTTPS_*` / `TLS_*` — server and TLS config
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `ALLOWED_EMAILS` — OAuth
- `PUSHOVER_*` — push notifications
- `RING_REFRESH_TOKEN` — Ring integration
- `MCP_HTTP_PORT` / `MCP_CONTROLLER_IP` / `MCP_DIRECTOR_TOKEN` — MCP server
