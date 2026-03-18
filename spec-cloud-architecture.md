# WebControl4 Cloud Architecture Spec

## Status: Ready for Implementation
## Owner: Mazhar
## Target: Claude Code execution

---

## 1. Problem Statement

WebControl4 currently runs as a monolithic server on a LAN-connected ARM64 Ubuntu box. The React frontend is served by the same Node.js process that bridges to Control4, Ring, and Govee. Remote access requires port-forwarding through the home firewall, which introduces latency, NAT issues, and security exposure.

Ring and Govee are already fetched from their cloud APIs. Control4 is the only system requiring a local bridge (no cloud API — must talk to the director on the LAN). The architecture should reflect this reality.

## 2. Design Principles

1. **Additive, not destructive.** MQTT is bolted on as a parallel transport. No existing REST/SSE/Express code is removed. The local server continues to work exactly as it does today.
2. **Dual-mode frontend.** The same React app runs in two modes:
   - **Local mode** (served from Express on LAN): full functionality via REST/SSE — chat, routines CRUD, trending, cameras, settings, everything.
   - **Remote mode** (served from GitHub Pages): device state/control, routine triggering, camera snapshots, and trending via MQTT. Non-applicable features (LLM chat, routine editing, settings) are gracefully hidden.
3. **Pushover for emergency notifications.** The existing Pushover integration continues to handle proactive alerts (water leak, door open too long, battery low, etc.) regardless of whether a remote client is connected.

## 3. Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│  GitHub Pages (static hosting) — REMOTE MODE            │
│  ┌───────────────────────────────────────────────────┐  │
│  │  React + Fluent UI v9 SPA (Vite build output)     │  │
│  │  - Connects to MQTT broker via WebSocket           │  │
│  │  - Device state via MQTT subscriptions             │  │
│  │  - Device commands via MQTT publishes              │  │
│  │  - Routine triggering, snapshots, trending via RPC │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
            │
            │ wss:// (MQTT over WebSocket)
            ▼
┌─────────────────────────────────────────────────────────┐
│  MQTT Broker (HiveMQ Cloud free tier)                   │
│  - Auth: username/password per client                   │
│  - TLS required on all connections                      │
│  - WebSocket endpoint for browser clients (port 8884)   │
│  - Standard MQTT endpoint for local bridge (port 8883)  │
└─────────────────────────────────────────────────────────┘
            │
            │ mqtts:// (MQTT over TLS)
            ▼
┌─────────────────────────────────────────────────────────┐
│  Local Bridge (ARM64 Ubuntu Server) — UNCHANGED + MQTT  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Existing Express server (fully preserved)         │  │
│  │  - REST API, SSE, OAuth, MCP, Routines, Trending   │  │
│  │  - Serves React SPA for LAN clients (local mode)   │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Control4    │  │ Ring     │  │ Govee             │  │
│  │ Adapter     │  │ Adapter  │  │ Adapter           │  │
│  │ (LAN only)  │  │ (cloud)  │  │ (cloud)           │  │
│  └──────┬──────┘  └────┬─────┘  └────────┬──────────┘  │
│         │              │                  │              │
│         ▼              ▼                  ▼              │
│  ┌───────────────────────────────────────────────────┐  │
│  │  MQTT Module (NEW — parallel transport)            │  │
│  │  - Publishes device state updates to broker        │  │
│  │  - Subscribes to command topics                    │  │
│  │  - Handles RPC requests (snapshots, trending, etc) │  │
│  │  - Publishes routine list for remote clients       │  │
│  │  - Handles reconnection and QoS                    │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Pushover (existing — unchanged)                   │  │
│  │  - Emergency alerts pushed regardless of client     │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 4. MQTT Topic Schema

All topics are namespaced under a home identifier to support future multi-home scenarios.

```
Prefix: wc4/{home_id}/

State (bridge → clients):
  wc4/{home_id}/state/{system}/{device_id}       → JSON full device state (retained)
  wc4/{home_id}/state/home                        → home mode, alerts, occupancy (retained)
  wc4/{home_id}/state/scenes                      → available Control4 scenes (retained)
  wc4/{home_id}/status/bridge                     → bridge heartbeat (retained)

Commands (clients → bridge):
  wc4/{home_id}/cmd/{system}/{device_id}/set      → JSON command payload
  wc4/{home_id}/cmd/{system}/{device_id}/action   → JSON action payload

Routines (bridge ↔ clients):
  wc4/{home_id}/state/routines/list               → JSON array of available routines (retained)
  wc4/{home_id}/cmd/routines/{routineId}/execute   → trigger routine execution
  wc4/{home_id}/state/routines/{routineId}/result  → execution result

RPC (clients → bridge → clients):
  wc4/{home_id}/rpc/request                       → { id, method, params }
  wc4/{home_id}/rpc/response/{requestId}          → { id, result, error }

System values: "control4" | "ring" | "govee"
```

### State Topic Examples

Device state payloads carry the **full UnifiedDevice envelope** — not just state fields — so remote
clients can reconstruct the device map from retained messages alone (no REST call needed).

```
wc4/home1/state/control4/42 →
  {
    "id": "control4:42",
    "source": "control4",
    "type": "light",
    "name": "Living Room Light",
    "roomId": 10,
    "roomName": "Living Room",
    "floorName": "Main Floor",
    "state": { "type": "light", "on": true, "level": 75 },
    "ts": "2026-03-13T12:00:00Z"
  }

wc4/home1/state/ring/alarm →
  {
    "id": "ring:alarm",
    "source": "ring",
    "type": "security",
    "name": "Ring Alarm",
    "roomId": null,
    "roomName": "Outdoor",
    "floorName": "",
    "state": { "type": "security", "mode": "home", "partitionState": "some", "alarmType": "" },
    "ts": "..."
  }

wc4/home1/state/ring/cam-front-001 →
  {
    "id": "ring:cam-front-001",
    "source": "ring",
    "type": "camera",
    "name": "Front Door Camera",
    "roomId": null,
    "roomName": "Outdoor",
    "floorName": "",
    "state": { "type": "camera", "online": true, "hasLight": true, "lightOn": false, "hasSiren": false, "sirenOn": false, "snapshotUrl": null },
    "ts": "..."
  }

wc4/home1/state/govee/H5054-leak-001 →
  {
    "id": "govee:H5054-leak-001",
    "source": "govee",
    "type": "sensor",
    "name": "Kitchen Leak Sensor",
    "roomId": null,
    "roomName": "",
    "floorName": "",
    "state": { "type": "sensor", "sensorKind": "flood", "triggered": false, "lastTriggered": null, "batteryLevel": 95 },
    "ts": "..."
  }

wc4/home1/state/home →
  {
    "mode": "home",
    "confidence": 0.9,
    "occupiedRooms": ["Living Room", "Kitchen"],
    "alerts": [{ "id": "...", "type": "door_open", "message": "...", "deviceId": "42", "deviceName": "Front Door", "timestamp": 1710300000000 }],
    "ts": "..."
  }

wc4/home1/state/scenes →
  [{ "id": 501, "name": "Movie Time", "roomId": 10, "roomName": "Living Room" }, ...]

wc4/home1/status/bridge →
  { "online": true, "uptime": 3600, "ts": "..." }
```

### Command Topic Examples
```
wc4/home1/cmd/control4/42/set       → {"level":50,"ts":"..."}
wc4/home1/cmd/ring/alarm/set        → {"mode":"away","ts":"..."}
wc4/home1/cmd/routines/morning/execute → {"ts":"..."}
```

### RPC Examples
```
// Request a camera snapshot
wc4/home1/rpc/request → {"id":"abc123","method":"getSnapshot","params":{"cameraId":"front_door_cam"}}
wc4/home1/rpc/response/abc123 → {"id":"abc123","result":{"image":"data:image/jpeg;base64,...","ts":"..."}}

// Request trending data
wc4/home1/rpc/request → {"id":"def456","method":"getTrending","params":{"deviceId":"42","range":"24h"}}
wc4/home1/rpc/response/def456 → {"id":"def456","result":{"points":[...],"summary":{...}}}

// Request device history
wc4/home1/rpc/request → {"id":"ghi789","method":"getHistory","params":{"deviceId":"42","limit":50}}
wc4/home1/rpc/response/ghi789 → {"id":"ghi789","result":{"events":[...]}}
```

### QoS Levels
- State updates: QoS 1 (at least once) with `retain: true` so new clients get last-known state immediately
- Commands: QoS 1 (at least once), no retain
- RPC requests: QoS 1, no retain
- RPC responses: QoS 1, no retain
- Routine list: QoS 1, retained (updated whenever routines change)
- Bridge heartbeat: QoS 1, retained, published every 30s. Broker LWT (Last Will and Testament) publishes `{"online": false}` on disconnect

### Payload Format
All payloads are JSON. Every state payload includes a `ts` field (ISO 8601 UTC timestamp) set by the bridge at publish time.

```typescript
// State payload envelope — mirrors UnifiedDevice from client/src/types/devices.ts
// The state-publisher transforms StateMachine variable-change events into this format
interface MqttDevicePayload {
  id: string;             // "control4:42", "ring:cam-front-001", "govee:H5054-leak-001"
  source: "control4" | "ring" | "govee";
  type: "light" | "thermostat" | "lock" | "sensor" | "camera" | "security" | "media";
  name: string;
  roomId: number | null;
  roomName: string;
  floorName: string;
  state: DeviceState;     // same union type as frontend (LightState | ThermostatState | ...)
  ts: string;             // ISO 8601 UTC, set by bridge at publish time
}

// Command payload envelope
interface DeviceCommand {
  ts: string;             // ISO 8601 UTC, set by client
  [key: string]: any;     // command-specific fields (e.g., { level: 50 }, { mode: "away" })
}

// RPC request
interface RpcRequest {
  id: string;             // unique request ID (client-generated UUID)
  method: string;         // "getSnapshot" | "getTrending" | "getHistory"
  params: object;         // method-specific parameters
}

// RPC response
interface RpcResponse {
  id: string;             // matches request ID
  result?: any;           // success payload
  error?: string;         // error message if failed
}
```

### Command Mapping

MQTT commands map to existing server-side functions. The command-handler reuses the same
code paths that the REST endpoints and routine scheduler already use:

| MQTT Command | Server Function | Notes |
|---|---|---|
| `cmd/control4/{itemId}/set` with `{level: N}` | `executeScheduledCommand(itemId, "SET_LEVEL", {LEVEL: N})` | Same as routine scheduler |
| `cmd/control4/{itemId}/set` with `{on: bool}` | `executeScheduledCommand(itemId, "SET_LEVEL", {LEVEL: on ? 100 : 0})` | Toggle via level |
| `cmd/control4/{itemId}/set` with `{hvacMode: M}` | `executeScheduledCommand(itemId, "SET_MODE_HVAC", {MODE: M})` | |
| `cmd/control4/{itemId}/set` with `{heatSetpointF: N}` | `executeScheduledCommand(itemId, "SET_SETPOINT_HEAT", {FAHRENHEIT: N})` | |
| `cmd/control4/{itemId}/set` with `{coolSetpointF: N}` | `executeScheduledCommand(itemId, "SET_SETPOINT_COOL", {FAHRENHEIT: N})` | |
| `cmd/control4/{itemId}/set` with `{fanMode: M}` | `executeScheduledCommand(itemId, "SET_FAN_MODE", {MODE: M})` | |
| `cmd/ring/alarm/set` with `{mode: M}` | `ring.setAlarmMode(mode)` | mode: "away"\|"home"\|"disarm" |
| `cmd/routines/{id}/execute` | Lookup routine from `data/routines.json`, call `executeRoutineSteps(routine)` | New helper needed |

## 5. Component Specifications

### 5.1 MQTT Module (Server-Side)

**Location:** `mqtt/` directory at repository root (alongside existing `server.js`, `state-machine.js`, etc.)

**Language:** JavaScript (matches existing server code)

**Dependencies to add to root `package.json`:**
```json
{
  "mqtt": "^5.x"
}
```

**New files:**

1. **`mqtt/mqtt-client.js`** — Core MQTT connection manager
   - Connects to HiveMQ Cloud broker over `mqtts://` (port 8883)
   - Credentials from env vars: `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_HOME_ID`
   - Configures LWT on `wc4/{home_id}/status/bridge` with payload `{"online": false, "ts": "..."}`
   - Exports `publish(topic, payload, options?)` and `subscribe(topic, handler)` functions
   - Handles reconnection with exponential backoff (1s, 2s, 4s, max 30s)
   - Logs connection state transitions
   - Graceful shutdown: publishes offline status, then disconnects

2. **`mqtt/state-publisher.js`** — Bridges internal state to MQTT
   - Listens to `StateMachine` `stateChange` events (same `stateChange` event that drives SSE/`broadcastSSE` today)
   - On each `stateChange` (which carries `{itemId, varName, value}`), looks up the **full device object** from `StateMachine.devices` and transforms it into an `MqttDevicePayload` envelope (id, source, type, name, room, floor, state) before publishing
   - Publishes to `wc4/{home_id}/state/control4/{itemId}` with QoS 1, retain true
   - Also listens for `homeState` changes (same event that triggers `broadcastSSE("homeState", ...)`) and publishes to `wc4/{home_id}/state/home` (retained)
   - Publishes Ring device state when Ring adapter emits updates (cameras, sensors, alarm mode)
   - Publishes Govee leak sensor state from the Govee singleton store's change events
   - Publishes bridge heartbeat every 30 seconds to `wc4/{home_id}/status/bridge`
   - On startup, publishes full state snapshot for **all** known devices (so retained messages are current after a bridge restart)
   - On startup, publishes scenes list to `wc4/{home_id}/state/scenes` (retained)
   - Publishes routine list to `wc4/{home_id}/state/routines/list` (retained), re-publishes whenever routines are created/updated/deleted via the REST API

3. **`mqtt/command-handler.js`** — Routes MQTT commands to adapters
   - Subscribes to `wc4/{home_id}/cmd/#`
   - Parses topic to extract system, device_id, and action type
   - Routes commands to the appropriate adapter using **existing server functions** (see Command Mapping table above):
     - `control4` → `executeScheduledCommand(itemId, command, params)` (same function the routine scheduler uses)
     - `ring` → `ring.setAlarmMode(mode)` and other Ring client functions
   - Subscribes to `wc4/{home_id}/cmd/routines/+/execute`
   - Looks up routine by ID from `data/routines.json`, calls `executeRoutineSteps(routine)` — requires a small helper to load and find routines by ID (the file is already read/written by the existing REST CRUD endpoints)
   - Publishes execution result to `wc4/{home_id}/state/routines/{routineId}/result`

4. **`mqtt/rpc-handler.js`** — Handles request/response RPC over MQTT
   - Subscribes to `wc4/{home_id}/rpc/request`
   - Dispatches by `method` field:
     - `getSnapshot` → calls Ring camera snapshot API, returns base64 JPEG
     - `getTrending` → queries SQLite trending DB, returns JSON time-series
     - `getHistory` → queries SQLite event history, returns JSON events
   - Publishes response to `wc4/{home_id}/rpc/response/{requestId}`
   - Timeout: if processing takes > 10s, responds with error
   - Max response payload: 256KB (HiveMQ free tier limit)

5. **`mqtt/device-map.js`** — Maps internal IDs to MQTT topic slugs
   - Auto-generates device map from `StateMachine.getDevices()` at startup
   - Uses the device's internal `itemId` as the MQTT device_id (e.g., `42`, `105`)
   - For Ring/Govee: uses existing device identifiers from their adapters
   - Provides bidirectional lookup: internal ID ↔ MQTT device_id
   - No static JSON config file — fully dynamic from discovery

**Integration point — `server.js`:**
- Add MQTT initialization after existing adapter setup (Control4, Ring, Govee)
- MQTT is optional: if `MQTT_BROKER_URL` env var is not set, MQTT module is not loaded (server works exactly as before)
- Add graceful shutdown hook for MQTT disconnect

**Environment variables (add to `.env.example`):**
```bash
# MQTT Cloud Bridge (optional — omit to run without remote access)
MQTT_BROKER_URL=mqtts://your-cluster.hivemq.cloud:8883
MQTT_USERNAME=webcontrol4-bridge
MQTT_PASSWORD=<generated>
MQTT_HOME_ID=home1
```

### 5.2 Frontend Dual-Mode Transport

**Location:** `client/src/` directory (existing React app)

**Dependencies to add to `client/package.json`:**
```json
{
  "mqtt": "^5.x"
}
```

**Transport mode detection:**
- Build-time: `VITE_TRANSPORT` env var (`local` or `mqtt`)
- The local build (served from Express) uses `VITE_TRANSPORT=local` (or omits it — local is the default)
- The GitHub Pages build uses `VITE_TRANSPORT=mqtt`
- A `client/src/config/transport.ts` module exports the mode and MQTT config

**Key design decision: MQTT feeds the existing DeviceContext.**

In local mode, the data flow is:
```
REST /api/state → mapStateDevices() → dispatch SET_DEVICES → DeviceContext
SSE /api/events → useSSE()          → dispatch UPDATE_DEVICE_VAR → DeviceContext
Components read from DeviceContext via useDeviceContext() — no transport awareness
```

In remote/MQTT mode, the data flow is:
```
MQTT retained messages → MqttProvider → dispatch SET_DEVICES → DeviceContext
MQTT live updates      → MqttProvider → dispatch UPDATE_DEVICE → DeviceContext
Components read from DeviceContext via useDeviceContext() — no transport awareness
```

Because MQTT state payloads carry full `MqttDevicePayload` envelopes (matching the `UnifiedDevice`
shape), the MqttProvider can construct `UnifiedDevice` objects directly and dispatch them into the
same `DeviceContext` the components already consume. **Device components need zero changes.**

The only component changes are:
- Commands: a transport-aware `sendDeviceCommand()` replaces direct calls to `director.ts`
- Navigation: hide LAN-only features when `isRemoteMode()` is true
- Auth: bypass OAuth flow in remote mode (MQTT credentials are the auth gate)

**New files:**

1. **`client/src/config/transport.ts`** — Transport configuration
   - Exports transport mode: `"local"` or `"mqtt"` (from `VITE_TRANSPORT` env var, defaults to `"local"`)
   - Exports MQTT config from Vite env vars when in mqtt mode
   - Validates required MQTT config is present, logs clear error if missing
   - Exports helper: `isRemoteMode(): boolean`

2. **`client/src/services/mqtt-client.ts`** — Browser MQTT client
   - Only initialized when transport mode is `"mqtt"`
   - Connects to HiveMQ Cloud broker over `wss://` (WebSocket + TLS, port 8884)
   - Credentials from Vite env vars: `VITE_MQTT_BROKER_WS_URL`, `VITE_MQTT_USERNAME`, `VITE_MQTT_PASSWORD`, `VITE_MQTT_HOME_ID`
   - Exports singleton MQTT client instance
   - Typed `subscribe<T>(topic, handler)` and `publish(topic, payload)` wrappers
   - Connection state tracking: `connected`, `reconnecting`, `disconnected`
   - Clean disconnect on window `beforeunload`

3. **`client/src/services/mqtt-rpc.ts`** — RPC client for request/response calls
   - `rpcCall(method, params): Promise<result>` — publishes request, subscribes to response topic, returns promise
   - Auto-generates unique request IDs
   - Timeout after 15s with rejection
   - Methods: `getSnapshot`, `getTrending`, `getHistory`

4. **`client/src/services/device-commands.ts`** — Transport-aware command dispatcher
   - `sendDeviceCommand(system, deviceId, command, params): Promise<void>`
   - In local mode: calls existing `sendCommand()` from `director.ts` (REST to local server)
   - In mqtt mode: publishes to `wc4/{home_id}/cmd/{system}/{deviceId}/set`
   - Components call this instead of `director.ts` directly
   - Ring commands (alarm mode) have their own path: `sendRingCommand(command, params)`

5. **`client/src/hooks/useBridgeStatus.ts`** — Bridge health hook (mqtt mode only)
   - `useBridgeStatus(): { online, uptime, lastSeen }`
   - Subscribes to `wc4/{home_id}/status/bridge`
   - Used by MqttProvider to show bridge offline banner

6. **`client/src/hooks/useMqttRoutines.ts`** — Routine triggering hook (mqtt mode only)
   - `useMqttRoutines(): { routines, executeRoutine, lastResult }`
   - Subscribes to `wc4/{home_id}/state/routines/list` for available routines
   - `executeRoutine(id)` publishes to `wc4/{home_id}/cmd/routines/{id}/execute`
   - Subscribes to result topic for execution feedback

7. **`client/src/contexts/MqttProvider.tsx`** — MQTT → DeviceContext bridge
   - Only renders when transport mode is `"mqtt"`
   - Initializes the MQTT connection on mount
   - Subscribes to `wc4/{home_id}/state/#` — receives all device state messages
   - Transforms `MqttDevicePayload` messages into `UnifiedDevice` objects
   - Dispatches `SET_DEVICES` into `DeviceContext` after initial retained messages are collected (short settling window ~500ms after last retained message)
   - Dispatches `UPDATE_DEVICE` for subsequent live updates
   - Subscribes to `wc4/{home_id}/state/home` for alerts → dispatches `SET_ALERTS`
   - Subscribes to `wc4/{home_id}/state/scenes` for scenes → dispatches `SET_SCENES`
   - Manages MQTT connection state → dispatches `SET_CONNECTION`
   - Renders a Fluent UI `MessageBar` banner when broker connection is lost
   - Renders a distinct bridge offline banner when heartbeat is stale

8. **`client/src/contexts/TransportProvider.tsx`** — Transport abstraction layer
   - Wraps the app at the top level
   - In local mode: renders children directly (existing REST/SSE flow, unchanged)
   - In mqtt mode: wraps children in `MqttProvider`
   - Provides `useTransportMode()` hook so components can check the mode

**Modifications to existing files:**

- **`client/src/App.tsx`**: Wrap in `TransportProvider`. In mqtt mode, skip the OAuth auth flow (`AuthContext` stages) and render `ConnectedApp` directly — MQTT credentials are the auth gate. In mqtt mode, skip the SSE `useSSE(dispatch)` call and the REST `getState()` initial load (MqttProvider handles both).
- **`client/src/types/devices.ts`**: Add `"govee"` to `DeviceSource` union type.
- **Device components** (LightCard, ThermostatCard, LockCard, etc.): Replace direct `sendCommand(opts, itemId, ...)` calls with `sendDeviceCommand(system, deviceId, ...)`. This is a mechanical change — the rendering logic stays identical.
- **Navigation/layout components**: Use `isRemoteMode()` to conditionally hide LAN-only features:
  - Hide: LLM Chat panel, Settings view, Routine editor (create/edit/delete)
  - Show: Routine list with trigger buttons (read-only + execute, using `useMqttRoutines` hook)
  - Show: Camera snapshots (fetched via RPC instead of REST)
  - Show: Trending/history charts (fetched via RPC instead of REST)

### 5.3 GitHub Pages Deployment

**New file: `.github/workflows/deploy-pages.yml`**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'client/**'
      - '.github/workflows/deploy-pages.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: client
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: client/package-lock.json

      - run: npm ci

      - run: npm run build
        env:
          VITE_TRANSPORT: mqtt
          VITE_MQTT_BROKER_WS_URL: ${{ secrets.MQTT_BROKER_WS_URL }}
          VITE_MQTT_USERNAME: ${{ secrets.MQTT_USERNAME }}
          VITE_MQTT_PASSWORD: ${{ secrets.MQTT_PASSWORD }}
          VITE_MQTT_HOME_ID: ${{ secrets.MQTT_HOME_ID }}

      # SPA routing fix: copy index.html to 404.html
      - run: cp ../public-react/index.html ../public-react/404.html

      - uses: actions/upload-pages-artifact@v3
        with:
          path: ../public-react

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Repository settings required:**
- Go to repo Settings → Pages → Source: "GitHub Actions"
- Add secrets: `MQTT_BROKER_WS_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_HOME_ID`

### 5.4 Vite Configuration Updates

**Modify: `client/vite.config.ts`**

When building for GitHub Pages (`VITE_TRANSPORT=mqtt`), set the `base` path:

```typescript
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: process.env.VITE_TRANSPORT === 'mqtt' ? '/webcontrol4/' : '/',
  server: {
    // ... existing proxy config (unchanged)
  },
  build: {
    outDir: '../public-react',
  },
}));
```

Note: If using a custom domain later, change the base back to `'/'`.

## 6. Remote Mode Feature Matrix

| Feature | Local Mode | Remote Mode | Remote Transport |
|---------|-----------|-------------|-----------------|
| Device state (lights, thermostats, locks, sensors) | REST/SSE | MQTT subscriptions | Real-time |
| Device control (set level, toggle, lock, arm) | REST | MQTT publish | Real-time |
| Ring alarm mode (home/away/disarm) | REST | MQTT publish | Real-time |
| Govee leak sensor status | SSE | MQTT subscriptions | Real-time |
| Home mode + alerts (door open, low battery) | SSE | MQTT subscription (`state/home`) | Real-time |
| Scenes list | REST | MQTT retained message (`state/scenes`) | Real-time |
| Routine list (read-only) | REST | MQTT retained message | Real-time |
| Routine execution (trigger) | REST | MQTT publish | Real-time |
| Camera snapshots | REST (binary) | RPC over MQTT (base64) | On-demand |
| Trending / history charts | REST (JSON) | RPC over MQTT (JSON) | On-demand |
| Bridge online/offline status | N/A (same box) | MQTT heartbeat + LWT | Real-time |
| Emergency notifications | Pushover (server-side) | Pushover (server-side) | Proactive push |
| LLM Chat | REST | **Not available** | — |
| Routine CRUD (create/edit/delete) | REST | **Not available** | — |
| Settings management | REST | **Not available** | — |
| Notification configuration | REST | **Not available** | — |
| MCP tools | STDIO/HTTP | **Not available** | — |

## 7. MQTT Broker Setup (HiveMQ Cloud)

Manual setup steps (not automated by Claude Code):

1. Create free cluster at https://console.hivemq.cloud/
2. Create two credentials:
   - `webcontrol4-bridge` — used by the local bridge (full pub/sub access)
   - `webcontrol4-client` — used by the frontend (subscribe to `state/#`, publish to `cmd/#` and `rpc/request` only)
3. Note the cluster URL, WebSocket port (8884), and MQTT port (8883)
4. Configure ACLs if supported on free tier:
   - Bridge: pub/sub `wc4/#`
   - Client: sub `wc4/+/state/#`, `wc4/+/status/#`, `wc4/+/rpc/response/#`; pub `wc4/+/cmd/#`, `wc4/+/rpc/request`

## 8. Security Considerations

- **No port forwarding required.** The local bridge connects outbound to the broker. The frontend loads from GitHub Pages. No inbound connections to the home network.
- **TLS everywhere.** MQTT over TLS (mqtts://), WebSocket over TLS (wss://). No plaintext.
- **Credentials in env vars / GitHub Secrets.** Never committed to the repo.
- **Local server fully preserved.** Google OAuth, session cookies, and all existing auth continue to protect the LAN interface. No auth changes needed.
- **Frontend MQTT credentials are visible in the browser.** The MQTT username/password baked into the Vite build are extractable. This is acceptable for a personal home automation system. For hardening:
  - Use a unique client credential with minimal ACLs (subscribe state, publish commands only)
  - Rotate credentials periodically
  - Consider adding Cloudflare Access in front of GitHub Pages as an additional auth gate (free tier, zero-trust, blocks unauthenticated access to the SPA entirely)
- **Emergency alerts via Pushover.** Critical alerts (water leaks, doors open too long, battery low) are pushed proactively by the server via the existing Pushover integration — no client connection required.

## 9. Implementation Plan

### Phase 1: MQTT Module on the Bridge
1. Set up HiveMQ Cloud cluster and credentials (manual)
2. Add `mqtt` dependency to root `package.json`
3. Implement `mqtt/mqtt-client.js` — connection, reconnect, LWT
4. Implement `mqtt/device-map.js` — auto-generate from StateMachine discovery
5. Implement `mqtt/state-publisher.js` — publish state changes + heartbeat
6. Implement `mqtt/command-handler.js` — subscribe to commands, route to adapters
7. Implement `mqtt/rpc-handler.js` — handle snapshot, trending, history requests
8. Wire MQTT init into `server.js` (conditional on `MQTT_BROKER_URL` env var)
9. Test: use MQTT Explorer to verify topics, payloads, QoS, retain, command round-trips

### Phase 2: Frontend Dual-Mode Transport
1. Add `mqtt` dependency to `client/package.json`
2. Implement `client/src/config/transport.ts` — mode detection + config
3. Implement `client/src/services/mqtt-client.ts` — browser MQTT connection
4. Implement `client/src/services/mqtt-rpc.ts` — RPC request/response client
5. Implement `client/src/services/device-commands.ts` — transport-aware command dispatcher
6. Implement hooks: `useBridgeStatus`, `useMqttRoutines`
7. Implement `MqttProvider` (feeds DeviceContext from MQTT) and `TransportProvider`
8. Update `App.tsx` — wrap in TransportProvider, bypass auth in mqtt mode, skip SSE in mqtt mode
9. Update `DeviceSource` type to include `"govee"`
10. Update device components to use `sendDeviceCommand()` instead of direct `director.ts` calls
11. Modify navigation to hide LAN-only features in remote mode
12. Wire up camera snapshot and trending views to use RPC in remote mode
13. Test locally: set `VITE_TRANSPORT=mqtt`, verify full MQTT path end-to-end
14. Test: verify `VITE_TRANSPORT=local` (or unset) still works identically (no regression)

### Phase 3: GitHub Pages Deployment
1. Update `client/vite.config.ts` with conditional `base` path
2. Add `.github/workflows/deploy-pages.yml`
3. Configure GitHub repo settings (Pages source: GitHub Actions)
4. Add GitHub Secrets for MQTT config
5. Push to main, verify GitHub Pages deployment
6. Test: load from GitHub Pages URL, verify MQTT connection, verify device control, verify RPC calls
7. Test: from phone on cellular, verify full remote workflow

## 10. Files Changed / Created Summary

### New Files
```
mqtt/mqtt-client.js              — MQTT connection manager (LWT, reconnect, pub/sub)
mqtt/state-publisher.js          — StateMachine events → MQTT state publishing
mqtt/command-handler.js          — MQTT commands → adapter routing + routine execution
mqtt/rpc-handler.js              — RPC over MQTT (snapshots, trending, history)
mqtt/device-map.js               — Auto-generated device ID mapping from StateMachine

client/src/config/transport.ts        — Transport mode detection + MQTT config
client/src/services/mqtt-client.ts    — Browser MQTT client singleton
client/src/services/mqtt-rpc.ts       — RPC request/response client
client/src/services/device-commands.ts — Transport-aware command dispatcher
client/src/hooks/useBridgeStatus.ts   — Bridge health hook
client/src/hooks/useMqttRoutines.ts   — Routine list + trigger hook
client/src/contexts/MqttProvider.tsx       — MQTT → DeviceContext bridge
client/src/contexts/TransportProvider.tsx  — Transport mode wrapper

.github/workflows/deploy-pages.yml   — GitHub Pages CI/CD
```

### Modified Files
```
package.json                — add mqtt dependency
client/package.json         — add mqtt dependency
client/vite.config.ts       — conditional base path for GitHub Pages
client/src/App.tsx          — wrap in TransportProvider, bypass auth + skip SSE in mqtt mode
client/src/types/devices.ts — add "govee" to DeviceSource union
client/src/components/*     — use sendDeviceCommand() + hide LAN-only features in remote mode
server.js                   — add MQTT module initialization (conditional, additive)
.env.example                — add MQTT env vars (documented as optional)
```

### Deleted Files
```
(none — no existing code is removed)
```

## 11. Testing Checklist

### Phase 1 — Bridge MQTT
- [ ] Bridge connects to HiveMQ Cloud and publishes heartbeat
- [ ] Bridge publishes retained state for all discovered devices on startup (full UnifiedDevice envelope)
- [ ] Bridge publishes home state (mode, alerts) to `state/home` topic
- [ ] Bridge publishes scenes list to `state/scenes` topic
- [ ] Bridge publishes routine list to `state/routines/list` topic
- [ ] Device state changes are published within 500ms of SSE broadcast
- [ ] Commands from MQTT Explorer are executed by the correct adapter (Control4 + Ring)
- [ ] Routine execution via MQTT command topic works (lookup by ID + execute)
- [ ] RPC: `getSnapshot` returns base64 camera image (< 256KB)
- [ ] RPC: `getTrending` returns time-series JSON
- [ ] RPC: `getHistory` returns event history JSON
- [ ] Bridge LWT fires `{"online": false}` when process is killed
- [ ] Bridge reconnects after broker restart
- [ ] Server works identically when `MQTT_BROKER_URL` is not set (no regression)

### Phase 2 — Frontend MQTT
- [ ] `VITE_TRANSPORT=local` (or unset): app works exactly as before (no regression)
- [ ] `VITE_TRANSPORT=mqtt`: frontend connects to broker via WebSocket
- [ ] Device state appears in UI from MQTT subscriptions
- [ ] Device commands (lights, thermostat, locks, alarm) work via MQTT
- [ ] Routine list appears, trigger buttons work
- [ ] Camera snapshots load via RPC
- [ ] Trending charts load via RPC
- [ ] LAN-only features (chat, settings, routine CRUD) are hidden in remote mode
- [ ] Connection loss shows reconnecting banner
- [ ] Bridge offline shows distinct banner

### Phase 3 — GitHub Pages
- [ ] GitHub Actions builds and deploys on push to main
- [ ] SPA routing works on GitHub Pages (direct URL navigation via 404.html)
- [ ] Frontend loads and connects from external network (phone on cellular)
- [ ] Round-trip command latency < 1s from external network
- [ ] Pushover emergency notifications still fire from bridge (independent of client)

## 12. Cost

| Component | Monthly Cost |
|-----------|-------------|
| GitHub Pages | $0 |
| HiveMQ Cloud (free tier, 100 connections) | $0 |
| Pushover (existing) | $0 (one-time $5 purchase, already owned) |
| Domain (optional) | ~$1/mo amortized |
| **Total** | **$0 – $1/mo** |
