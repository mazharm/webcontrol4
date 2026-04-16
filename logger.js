// ---------------------------------------------------------------------------
// logger.js – tiny structured logger (no deps)
// ---------------------------------------------------------------------------
// Produces single-line JSON records when LOG_FORMAT=json, otherwise a compact
// human format matching the legacy console.log("[module]", ...) style.
//
// Usage:
//   const { createLogger } = require("./logger");
//   const log = createLogger("ws", { connectionId: "abc123" });
//   log.info("connected", { url });
//   log.error("connect-failed", { error: err.message });
//
// Returned logger is also callable:  log("event-name", { ...fields })
// → behaves as info(), which is what existing modules expect when a
// `logger: (...args) => ...` function is passed in.
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = process.env.LOG_LEVEL?.toLowerCase() || "info";
const FORMAT = process.env.LOG_FORMAT?.toLowerCase() === "json" ? "json" : "text";

function shouldLog(level) {
  return (LEVELS[level] || 20) >= (LEVELS[DEFAULT_LEVEL] || 20);
}

function emit(rec) {
  if (FORMAT === "json") {
    process.stdout.write(JSON.stringify(rec) + "\n");
    return;
  }
  const { ts, level, module: mod, event, ...rest } = rec;
  const keys = Object.keys(rest);
  const tail = keys.length
    ? " " + keys.map((k) => {
        const v = rest[k];
        if (v && typeof v === "object") {
          try { return `${k}=${JSON.stringify(v)}`; } catch { return `${k}=[unserializable]`; }
        }
        return `${k}=${v}`;
      }).join(" ")
    : "";
  const line = `[${level}] [${mod}] ${event}${tail}`;
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function record(mod, bindings, level, event, fields) {
  if (!shouldLog(level)) return;
  emit({
    ts: new Date().toISOString(),
    level,
    module: mod,
    event: String(event ?? ""),
    ...bindings,
    ...(fields && typeof fields === "object" ? fields : fields !== undefined ? { value: fields } : {}),
  });
}

function createLogger(mod, bindings = {}) {
  // The logger itself is callable as (event, fields) → info.  This preserves
  // compatibility with callers that pass a `logger: (...args) => console.log(...)`
  // function into submodules.
  const fn = (event, fields) => record(mod, bindings, "info", event, fields);
  fn.debug = (event, fields) => record(mod, bindings, "debug", event, fields);
  fn.info  = (event, fields) => record(mod, bindings, "info",  event, fields);
  fn.warn  = (event, fields) => record(mod, bindings, "warn",  event, fields);
  fn.error = (event, fields) => record(mod, bindings, "error", event, fields);
  fn.child = (extra) => createLogger(mod, { ...bindings, ...extra });
  return fn;
}

module.exports = { createLogger };
