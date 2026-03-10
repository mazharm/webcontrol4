// ---------------------------------------------------------------------------
// Pushover notification module (zero external dependencies)
// ---------------------------------------------------------------------------

const https = require("https");

// --- Priority constants ---
const Priority = {
  LOWEST: -2,    // no notification, just badge
  LOW: -1,       // no sound/vibration, popup only
  NORMAL: 0,     // sound + vibration per user settings
  HIGH: 1,       // bypasses quiet hours, always sounds
  EMERGENCY: 2,  // repeats until acknowledged
};

// --- Sound presets ---
const Sounds = {
  ALARM: "siren",
  ALERT: "spacealarm",
  DOORBELL: "incoming",
  INFO: "pushover",
  SILENT: "none",
};

// --- Deduplication ---
const recentMessages = new Map(); // key → timestamp
const COOLDOWN_MS = 30_000;

function isDuplicate(key) {
  const last = recentMessages.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) return true;
  recentMessages.set(key, Date.now());
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentMessages) {
    if (now - ts > COOLDOWN_MS * 2) recentMessages.delete(key);
  }
}, 60_000).unref();

// --- Rate limit backoff ---
let backoffUntil = 0;

// --- Notification log (ring buffer) ---
const notificationLog = [];
const LOG_MAX = 50;

function addToLog(opts, result) {
  notificationLog.unshift({
    ts: Date.now(),
    title: opts.title || "WebControl4",
    message: opts.message,
    priority: opts.priority ?? Priority.NORMAL,
    success: result.success,
    error: result.errors ? result.errors[0] : undefined,
  });
  if (notificationLog.length > LOG_MAX) notificationLog.length = LOG_MAX;
}

function getLog(limit = 20) {
  return notificationLog.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Core send function
// ---------------------------------------------------------------------------

async function send(opts) {
  if (process.env.PUSHOVER_ENABLED === "false") {
    return { success: true, skipped: true };
  }

  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) {
    console.warn("[Notify] Pushover not configured — skipping");
    return { success: false, errors: ["PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY not set"] };
  }

  // Deduplication
  const dedupeKey = `${opts.title || ""}:${opts.message}`;
  if (isDuplicate(dedupeKey)) {
    return { success: true, skipped: true, reason: "duplicate" };
  }

  // Backoff check
  if (Date.now() < backoffUntil) {
    return { success: false, errors: ["Rate limited — backing off"] };
  }

  // Build form fields
  const fields = { token, user, message: String(opts.message || "").slice(0, 1024) };
  if (opts.title) fields.title = String(opts.title).slice(0, 250);
  if (opts.priority != null) fields.priority = String(opts.priority);
  if (opts.sound) fields.sound = opts.sound;
  if (opts.url) fields.url = String(opts.url).slice(0, 512);
  if (opts.urlTitle) fields.url_title = String(opts.urlTitle).slice(0, 100);
  if (opts.ttl) fields.ttl = String(opts.ttl);
  if (opts.device || process.env.PUSHOVER_DEVICE) {
    fields.device = opts.device || process.env.PUSHOVER_DEVICE;
  }
  if (opts.priority === Priority.EMERGENCY) {
    fields.retry = String(opts.retry || 60);
    fields.expire = String(opts.expire || 300);
  }

  // Encode as multipart/form-data
  const boundary = `----WebControl4-${Date.now()}`;
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    );
  }

  if (opts.image && Buffer.isBuffer(opts.image) && opts.image.length <= 5 * 1024 * 1024) {
    const mime = opts.imageMime || "image/jpeg";
    const ext = mime.includes("png") ? "png" : "jpg";
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="attachment"; filename="snapshot.${ext}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`
    );
  }

  const bodyParts = [Buffer.from(parts.join(""))];
  if (opts.image && Buffer.isBuffer(opts.image) && opts.image.length <= 5 * 1024 * 1024) {
    bodyParts.push(opts.image);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  } else {
    bodyParts.push(Buffer.from(`--${boundary}--\r\n`));
  }
  const body = Buffer.concat(bodyParts);

  const result = await doRequest(body, boundary);
  addToLog(opts, result);

  // Retry once on 5xx / network error
  if (!result.success && result._retryable) {
    await new Promise((r) => setTimeout(r, 5000));
    const retry = await doRequest(body, boundary);
    if (retry.success) return retry;
  }

  return result;
}

function doRequest(body, boundary) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.pushover.net",
        port: 443,
        path: "/1/messages.json",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Handle 429 rate limit
          if (res.statusCode === 429) {
            backoffUntil = Date.now() + 60_000;
            resolve({ success: false, errors: ["Rate limited by Pushover"] });
            return;
          }
          try {
            const json = JSON.parse(data);
            if (json.status === 1) {
              resolve({ success: true, receipt: json.receipt });
            } else {
              console.error("[Notify] Pushover error:", json.errors);
              resolve({ success: false, errors: json.errors });
            }
          } catch {
            resolve({ success: false, errors: [`Parse error: ${data.slice(0, 200)}`], _retryable: true });
          }
        });
      }
    );

    req.on("error", (err) => {
      console.error("[Notify] Pushover request failed:", err.message);
      resolve({ success: false, errors: [err.message], _retryable: true });
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Convenience methods
// ---------------------------------------------------------------------------

function alarm(message, image) {
  return send({
    title: "🚨 Ring Alarm",
    message,
    priority: Priority.EMERGENCY,
    sound: Sounds.ALARM,
    retry: 60,
    expire: 600,
    image,
  });
}

function alert(title, message, image) {
  return send({
    title,
    message,
    priority: Priority.HIGH,
    sound: Sounds.ALERT,
    image,
  });
}

function doorbell(message, image) {
  return send({
    title: "🔔 Doorbell",
    message,
    priority: Priority.NORMAL,
    sound: Sounds.DOORBELL,
    image,
    ttl: 300,
  });
}

function info(title, message) {
  return send({
    title,
    message,
    priority: Priority.LOW,
    sound: Sounds.SILENT,
    ttl: 3600,
  });
}

function status(message) {
  return send({
    title: "WebControl4",
    message,
    priority: Priority.LOWEST,
    sound: Sounds.SILENT,
  });
}

module.exports = {
  send,
  alarm,
  alert,
  doorbell,
  info,
  status,
  getLog,
  Priority,
  Sounds,
};
