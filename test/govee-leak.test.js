// ---------------------------------------------------------------------------
// govee-leak.test.js — poll-cadence behaviour of the Govee leak poller.
// _apiRequest is stubbed per-instance so no network is touched.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const GoveeLeak = require(path.resolve(__dirname, "..", "govee-leak.js"));

const silentLog = { info() {}, warn() {}, error() {} };

function makePoller({ pollInterval = 60 } = {}) {
  const govee = new GoveeLeak({
    email: "user@example.com",
    token: "test-token",
    tokenTimestamp: Date.now(),
    pollInterval,
    log: silentLog,
  });
  govee.devices.set("dev-1", {
    sku: "H5054",
    name: "Basement",
    leakDetected: false,
    battery: 100,
    online: true,
    gwOnline: true,
    lastTime: null,
  });
  return govee;
}

test("rate-limit backoff is preserved when every request fails", async () => {
  const govee = makePoller();
  // Simulate a previous cycle that backed off after hitting the rate limit.
  govee._currentPollInterval = 120;
  govee._apiRequest = async () => { throw new Error("Govee API returned HTTP 429"); };

  await govee.pollLeakStatus();

  assert.equal(
    govee._currentPollInterval, 120,
    "a fully-failing cycle must not cancel the backoff and resume fast polling"
  );
});

test("cadence is restored after a cycle that reaches the API", async () => {
  const govee = makePoller();
  govee._currentPollInterval = 120;
  govee._apiRequest = async () => ({ status: 200, headers: {}, data: { leak: false } });

  await govee.pollLeakStatus();

  assert.equal(govee._currentPollInterval, 60);
});

test("exhausted rate-limit budget doubles the interval", async () => {
  const govee = makePoller();
  govee._apiRequest = async () => ({
    status: 200,
    headers: { "x-ratelimit-remaining": "0" },
    data: { leak: false },
  });

  await govee.pollLeakStatus();

  assert.equal(govee._currentPollInterval, 120);
});

test("backoff is capped at the maximum poll interval", async () => {
  const govee = makePoller();
  govee._currentPollInterval = 300;
  govee._apiRequest = async () => ({
    status: 200,
    headers: { "x-ratelimit-remaining": "0" },
    data: { leak: false },
  });

  await govee.pollLeakStatus();

  assert.equal(govee._currentPollInterval, 300);
});

test("overlapping polls are skipped while one is in flight", async () => {
  const govee = makePoller();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  govee._apiRequest = async () => {
    calls++;
    await gate;
    return { status: 200, headers: {}, data: { leak: false } };
  };

  const first = govee.pollLeakStatus();
  await govee.pollLeakStatus(); // must return immediately, not start a second sweep
  release();
  await first;

  assert.equal(calls, 1);
});

test("a leak transition emits exactly one event", async () => {
  const govee = makePoller();
  const events = [];
  govee.onLeakEvent = (e) => events.push(e);
  govee._apiRequest = async () => ({ status: 200, headers: {}, data: { leak: true } });

  await govee.pollLeakStatus();

  assert.equal(events.length, 1);
  assert.equal(events[0].leakDetected, true);
  assert.equal(events[0].device, "dev-1");
  assert.equal(govee.getState().anyLeak, true);
});

test("a steady non-leak state emits nothing", async () => {
  const govee = makePoller();
  const events = [];
  govee.onLeakEvent = (e) => events.push(e);
  govee._apiRequest = async () => ({ status: 200, headers: {}, data: { leak: false } });

  await govee.pollLeakStatus();

  assert.equal(events.length, 0);
  assert.equal(govee.getState().anyLeak, false);
});
