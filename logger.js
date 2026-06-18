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
const SENSITIVE_KEY_RE = /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|refresh[_-]?token|private[_-]?key)/i;

function shouldLog(level) {
  return (LEVELS[level] || 20) >= (LEVELS[DEFAULT_LEVEL] || 20);
}

function sanitizeForLog(value, key = "", seen = new WeakSet()) {
  if (SENSITIVE_KEY_RE.test(key)) return "[Redacted]";
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item, "", seen));
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeForLog(childValue, childKey, seen);
  }
  return out;
}

function safeStringify(obj) {
  try {
    return JSON.stringify(sanitizeForLog(obj));
  } catch {
    return JSON.stringify({
      ts: obj && obj.ts,
      level: obj && obj.level,
      module: obj && obj.module,
      event: obj && obj.event,
      _logError: "unserializable record",
    });
  }
}

function emit(rec) {
  if (FORMAT === "json") {
    process.stdout.write(safeStringify(rec) + "\n");
    return;
  }
  const { ts, level, module: mod, event, ...rest } = sanitizeForLog(rec);
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
