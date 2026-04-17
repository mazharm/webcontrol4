// ---------------------------------------------------------------------------
// c4-websocket.test.js — unit tests for the Control4 WebSocket wrapper.
// Run with:  node --test test/c4-websocket.test.js
// ---------------------------------------------------------------------------
// socket.io-client is stubbed via require.cache before loading the module
// under test, so no network is touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const EventEmitter = require("node:events");
const Module = require("node:module");

// --- stub socket.io-client ----------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.disconnected = false;
    this.emitted = [];
    // socket.io's `onAny` — the real client exposes it separately
    this._anyHandlers = new Set();
  }
  onAny(fn) { this._anyHandlers.add(fn); }
  emit(eventName, ...args) {
    // Tests inject events by calling .trigger(); .emit() on the real socket
    // is used by production code to send messages to the server.
    this.emitted.push({ eventName, args });
    return true;
  }
  timeout() { return this; }                // noop chainable for ack-timeout
  disconnect() {
    this.disconnected = true;
    this.trigger("disconnect", "io client disconnect");
  }
  removeAllListeners() {
    super.removeAllListeners();
    this._anyHandlers.clear();
  }
  // Test helper: deliver an event as if the Director sent it.
  trigger(eventName, ...args) {
    for (const fn of this._anyHandlers) fn(eventName, ...args);
    super.emit(eventName, ...args);
  }
}

let lastFake = null;
const fakeIo = (/* url, opts */) => {
  lastFake = new FakeSocket();
  return lastFake;
};

// Install the stub into Node's module cache under the exact id the SUT uses.
function installStub() {
  const id = require.resolve("socket.io-client", { paths: [path.resolve(__dirname, "..")] });
  const mod = new Module(id);
  mod.exports = { io: fakeIo };
  mod.loaded = true;
  require.cache[id] = mod;
}
installStub();

// Clear the SUT from the cache so each test file pick up a fresh copy.
const sutPath = require.resolve(path.resolve(__dirname, "..", "c4-websocket.js"));
delete require.cache[sutPath];
const { C4WebSocket } = require(sutPath);

// --- helpers ------------------------------------------------------------------

function makeWs(overrides = {}) {
  return new C4WebSocket({
    directorIp: "192.168.1.10",
    directorToken: "tok-initial",
    refreshTokenFn: async () => ({ token: "tok-refreshed", validSeconds: 86400 }),
    logger: () => {},
    ...overrides,
  });
}

function nextTick() { return new Promise((r) => setImmediate(r)); }

// --- tests --------------------------------------------------------------------

test("connect() resolves on `connect` event", async () => {
  const ws = makeWs();
  const p = ws.connect();
  // Allow _setupSocket to install listeners, then fire connect.
  await nextTick();
  lastFake.trigger("connect");
  await p;
  assert.equal(ws.isConnected(), true);
  ws.disconnect();
});

test("connect() is idempotent when already connecting", async () => {
  const ws = makeWs();
  const p1 = ws.connect();
  const p2 = ws.connect();
  assert.equal(p1, p2, "returns the same promise while connecting");
  await nextTick();
  lastFake.trigger("connect");
  await p1;
  ws.disconnect();
});

test("handleEvent normalises varName/value format", async () => {
  const ws = makeWs();
  const received = [];
  ws.onAnyChange((p) => received.push(p));
  const p = ws.connect();
  await nextTick();
  lastFake.trigger("connect");
  await p;
  lastFake.trigger("N", { iddevice: 42, varName: "LIGHT_LEVEL", value: 75 });
  assert.equal(received.length, 1);
  assert.equal(received[0].itemId, 42);
  assert.equal(received[0].varName, "LIGHT_LEVEL");
  assert.equal(received[0].value, 75);
  ws.disconnect();
});

test("handleEvent deduplicates within the dedup window", async () => {
  const ws = makeWs();
  const received = [];
  ws.onAnyChange((p) => received.push(p));
  const p = ws.connect();
  await nextTick();
  lastFake.trigger("connect");
  await p;
  const payload = { iddevice: 7, varName: "LIGHT_STATE", value: "1" };
  lastFake.trigger("event", payload);
  lastFake.trigger("event", payload);   // duplicate — dropped
  lastFake.trigger("event", payload);   // duplicate — dropped
  assert.equal(received.length, 1);
  ws.disconnect();
});

test("handleEvent iterates the `changes` array format", async () => {
  const ws = makeWs();
  const received = [];
  ws.onAnyChange((p) => received.push(p));
  const p = ws.connect();
  await nextTick();
  lastFake.trigger("connect");
  await p;
  lastFake.trigger("N", {
    iddevice: 9,
    changes: [
      { varName: "LIGHT_LEVEL", value: 100 },
      { varName: "LIGHT_STATE", value: "1" },
    ],
  });
  assert.equal(received.length, 2);
  assert.equal(received[0].varName, "LIGHT_LEVEL");
  assert.equal(received[1].varName, "LIGHT_STATE");
  ws.disconnect();
});

test("reconnect backoff falls within jittered bounds", () => {
  const ws = makeWs();
  // Drive _scheduleReconnect repeatedly and capture the delays it would
  // compute.  We don't need to await real timers — we only verify the math.
  // Monkey-patch setTimeout to capture the delay and immediately clear it.
  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    delays.push(ms);
    const t = realSetTimeout(() => {}, 0);   // trivial handle — we never call fn
    if (t.unref) t.unref();
    clearTimeout(t);
    return t;
  };
  try {
    for (let i = 0; i < 6; i++) {
      ws._reconnectTimer = null;
      ws._scheduleReconnect();
    }
  } finally {
    global.setTimeout = realSetTimeout;
  }
  // attempts 1..6 → base = 1s, 2s, 4s, 8s, 16s, 30s (cap); ±25% jitter.
  const bases = [1000, 2000, 4000, 8000, 16000, 30000];
  for (let i = 0; i < bases.length; i++) {
    const b = bases[i];
    assert.ok(
      delays[i] >= b * 0.75 && delays[i] <= b * 1.25,
      `delay ${delays[i]} outside jitter range for base ${b}`,
    );
  }
  ws.disconnect();
});

test("reconnect keeps retrying past the alert threshold", () => {
  const ws = makeWs();
  let failedEvents = 0;
  ws.on("reconnectFailed", () => failedEvents++);
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (_fn, _ms) => {
    const t = realSetTimeout(() => {}, 0);
    if (t.unref) t.unref();
    clearTimeout(t);
    return t;
  };
  try {
    for (let i = 0; i < 45; i++) {
      ws._reconnectTimer = null;
      ws._scheduleReconnect();
    }
  } finally {
    global.setTimeout = realSetTimeout;
  }
  // Alerts every 20 attempts → attempts 20 and 40 → 2 alerts.
  assert.equal(failedEvents, 2);
  // But reconnect attempts keep climbing — we never permanently give up.
  assert.equal(ws._reconnectAttempts, 45);
  ws.disconnect();
});

test("disconnect() is idempotent and does not emit twice", () => {
  const ws = makeWs();
  let disconnects = 0;
  ws.on("disconnected", () => disconnects++);
  // Pretend we were connected so the first call emits.
  ws._connected = true;
  ws.disconnect();
  ws.disconnect();
  ws.disconnect();
  assert.equal(disconnects, 1);
});

test("getStats() reports connection and callback counts", async () => {
  const ws = makeWs();
  const p = ws.connect();
  await nextTick();
  lastFake.trigger("connect");
  await p;
  ws.onDeviceChange(1, () => {});
  ws.onDeviceChange(2, () => {});
  ws.onAnyChange(() => {});
  const stats = ws.getStats();
  assert.equal(stats.connected, true);
  assert.equal(stats.deviceCallbacks, 2);
  assert.equal(stats.anyCallbacks, 1);
  assert.ok(stats.lastEventAt !== null);
  ws.disconnect();
});

test("token refresh retry uses bounded backoff on failure", async () => {
  let calls = 0;
  const ws = makeWs({
    refreshTokenFn: async () => {
      calls++;
      throw new Error("network");
    },
  });
  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    delays.push(ms);
    // Don't actually schedule — we only care about the scheduling math.
    const t = realSetTimeout(() => {}, 0);
    if (t.unref) t.unref();
    clearTimeout(t);
    return t;
  };
  try {
    await ws._refreshToken();       // 1st failure → schedules 60_000ms retry
    await ws._refreshToken();       // 2nd failure → 120_000ms
    await ws._refreshToken();       // 3rd failure → 240_000ms
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 3);
  assert.deepEqual(delays, [60_000, 120_000, 240_000]);
  ws.disconnect();
});
