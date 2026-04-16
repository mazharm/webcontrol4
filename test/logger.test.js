// ---------------------------------------------------------------------------
// logger.test.js — unit tests for the tiny structured logger.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Load a fresh copy each test so env-driven behavior is re-evaluated.
function freshLogger(envOverrides = {}) {
  for (const k of Object.keys(envOverrides)) process.env[k] = envOverrides[k];
  const id = require.resolve(path.resolve(__dirname, "..", "logger.js"));
  delete require.cache[id];
  return require(id);
}

function captureStdout(fn) {
  const buf = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { buf.push(String(chunk)); return true; };
  process.stderr.write = (chunk, ...rest) => { buf.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return buf.join("");
}

test("logger is callable as info()", () => {
  const { createLogger } = freshLogger({ LOG_LEVEL: "debug", LOG_FORMAT: "text" });
  const log = createLogger("mod");
  const out = captureStdout(() => log("hello", { x: 1 }));
  assert.match(out, /\[info\]/);
  assert.match(out, /\[mod\]/);
  assert.match(out, /hello/);
  assert.match(out, /x=1/);
});

test("logger respects LOG_LEVEL=warn", () => {
  const { createLogger } = freshLogger({ LOG_LEVEL: "warn", LOG_FORMAT: "text" });
  const log = createLogger("mod");
  const out = captureStdout(() => {
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  });
  assert.doesNotMatch(out, /\[debug\]/);
  assert.doesNotMatch(out, /\[info\]/);
  assert.match(out, /\[warn\]/);
  assert.match(out, /\[error\]/);
});

test("logger emits JSON when LOG_FORMAT=json", () => {
  const { createLogger } = freshLogger({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
  const log = createLogger("ws", { connectionId: "abc123" });
  const out = captureStdout(() => log.info("connected", { port: 443 }));
  const line = out.trim().split("\n").filter(Boolean).pop();
  const rec = JSON.parse(line);
  assert.equal(rec.level, "info");
  assert.equal(rec.module, "ws");
  assert.equal(rec.event, "connected");
  assert.equal(rec.connectionId, "abc123");
  assert.equal(rec.port, 443);
  assert.ok(rec.ts);
});

test("child() inherits and extends bindings", () => {
  const { createLogger } = freshLogger({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
  const parent = createLogger("ws", { connectionId: "a" });
  const child = parent.child({ step: "reconnect" });
  const out = captureStdout(() => child.info("tick"));
  const rec = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
  assert.equal(rec.connectionId, "a");
  assert.equal(rec.step, "reconnect");
});
