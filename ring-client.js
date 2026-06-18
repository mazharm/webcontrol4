// ---------------------------------------------------------------------------
// Ring API client module (parallel to http-client.js)
// ---------------------------------------------------------------------------

const { RingApi, RingDeviceType } = require("ring-client-api");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

let ringApi = null;
let locations = [];
let connectionStatus = "disconnected"; // disconnected | connecting | connected | error
let tokenSubscription = null;

// Snapshot cache: cameraId -> { buffer, ts }
const snapshotCache = new Map();
const SNAPSHOT_CACHE_TTL = 10_000; // 10 seconds
const OAUTH_TIMEOUT_MS = 15_000;
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const HUB_TIMEOUT = 15_000; // 15s timeout for alarm hub operations
const CAMERA_TIMEOUT = 30_000; // 30s timeout for camera operations

// Pending login state for email/password + 2FA flow
let pendingLogin = null; // { email, password, hardwareId }
let pendingLoginTimer = null;
const PENDING_LOGIN_TTL = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Ring OAuth token request (direct HTTP, no library internals needed)
// ---------------------------------------------------------------------------

function ringOAuthRequest(grantData, hardwareId, twoFactorCode) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const body = JSON.stringify({
      client_id: "ring_official_android",
      scope: "client",
      ...grantData,
    });

    const req = https.request(
      {
        hostname: "oauth.ring.com",
        port: 443,
        path: "/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "2fa-support": "true",
          "2fa-code": twoFactorCode || "",
          hardware_id: hardwareId,
          "User-Agent": "android:com.ringapp",
        },
      },
      (res) => {
        let data = "";
        let received = 0;
        res.on("data", (chunk) => {
          received += Buffer.byteLength(chunk);
          if (received > MAX_OAUTH_RESPONSE_BYTES) {
            req.destroy(new Error("Ring OAuth response too large"));
            return;
          }
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200) {
              done({ success: true, data: json });
            } else if (res.statusCode === 412) {
              // 2FA required
              const prompt = json.tsv_state === "totp"
                ? "Enter the code from your authenticator app"
                : `Enter the code sent to ${json.phone || "your device"} via ${json.tsv_state || "SMS"}`;
              done({ success: false, requires2FA: true, prompt });
            } else if (res.statusCode === 400 && typeof json.error === "string" && json.error.startsWith("Verification Code")) {
              done({ success: false, requires2FA: true, prompt: "Invalid code. Please try again." });
            } else {
              const msg = json.error_description || json.error || `HTTP ${res.statusCode}`;
              done({ success: false, error: msg });
            }
          } catch {
            done({ success: false, error: `Unexpected response (HTTP ${res.statusCode})` });
          }
        });
      }
    );

    req.on("error", (err) => {
      done({ success: false, error: err.message });
    });
    req.setTimeout(OAUTH_TIMEOUT_MS, () => req.destroy(new Error("Ring OAuth request timed out")));

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Email/password login flow
// ---------------------------------------------------------------------------

async function loginWithEmail(email, password) {
  const hardwareId = crypto.randomUUID();
  const result = await ringOAuthRequest(
    { grant_type: "password", username: email, password },
    hardwareId
  );

  if (result.requires2FA) {
    // Store credentials for the 2FA verification step
    if (pendingLoginTimer) clearTimeout(pendingLoginTimer);
    pendingLogin = { email, password, hardwareId };
    pendingLoginTimer = setTimeout(() => { pendingLogin = null; pendingLoginTimer = null; }, PENDING_LOGIN_TTL);
    if (pendingLoginTimer.unref) pendingLoginTimer.unref();
    return result;
  }

  if (!result.success) return result;
  if (!result.data?.refresh_token) {
    return { success: false, error: "Ring login succeeded but did not return a refresh token" };
  }

  // Got a refresh token directly (no 2FA)
  if (pendingLoginTimer) { clearTimeout(pendingLoginTimer); pendingLoginTimer = null; }
  pendingLogin = null;
  const refreshToken = buildRefreshToken(result.data.refresh_token, hardwareId);
  persistToken(refreshToken);
  return initialize(refreshToken);
}

async function verify2FA(code) {
  if (!pendingLogin) {
    return { success: false, error: "No pending login. Start login flow first." };
  }

  const { email, password, hardwareId } = pendingLogin;
  const result = await ringOAuthRequest(
    { grant_type: "password", username: email, password },
    hardwareId,
    code
  );

  if (result.requires2FA) return result; // still needs valid code

  if (!result.success) return result;
  if (!result.data?.refresh_token) {
    return { success: false, error: "Ring verification succeeded but did not return a refresh token" };
  }

  pendingLogin = null;
  if (pendingLoginTimer) { clearTimeout(pendingLoginTimer); pendingLoginTimer = null; }
  const refreshToken = buildRefreshToken(result.data.refresh_token, hardwareId);
  persistToken(refreshToken);
  return initialize(refreshToken);
}

function buildRefreshToken(rawToken, hardwareId) {
  // ring-client-api expects a base64-encoded JSON with rt and hid
  return Buffer.from(JSON.stringify({ rt: rawToken, hid: hardwareId })).toString("base64");
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function initialize(refreshToken) {
  disconnect();
  snapshotCache.clear();
  connectionStatus = "connecting";
  try {
    ringApi = new RingApi({
      refreshToken,
      cameraStatusPollingSeconds: 30,
      cameraDingsPollingSeconds: 5,
    });

    // Persist rotated refresh tokens
    tokenSubscription = ringApi.onRefreshTokenUpdated.subscribe({
      next: ({ newRefreshToken }) => {
        persistToken(newRefreshToken);
      },
      error: (err) => {
        console.error("[Ring] Refresh-token subscription error:", err?.message || String(err));
      },
    });

    locations = await withTimeout(ringApi.getLocations(), HUB_TIMEOUT, "getLocations");
    connectionStatus = "connected";
    console.log(`[Ring] Connected. ${locations.length} location(s) found.`);
    return { success: true, locationCount: locations.length };
  } catch (err) {
    if (tokenSubscription) {
      try { tokenSubscription.unsubscribe(); } catch { /* ignore */ }
      tokenSubscription = null;
    }
    if (ringApi) {
      try { ringApi.disconnect(); } catch { /* ignore */ }
      ringApi = null;
    }
    locations = [];
    connectionStatus = "error";
    console.error("[Ring] Init failed:", err.message);
    return { success: false, error: err.message };
  }
}

// Persisted refresh-token path.  We deliberately keep this separate from
// `.env` because:
//   1. .env is a user-managed config file, often mounted or templated —
//      rewriting it mixes operator and application concerns and can
//      clobber operator edits.
//   2. secrets should live in a chmod-600 file, not alongside other config.
const RING_TOKEN_FILE = path.resolve(__dirname, "data", "ring-token");

function loadPersistedToken() {
  try {
    if (fs.existsSync(RING_TOKEN_FILE)) {
      return fs.readFileSync(RING_TOKEN_FILE, "utf8").trim() || null;
    }
  } catch (err) {
    console.error("[Ring] Failed to read persisted token:", err.message);
  }
  return null;
}

function persistToken(token) {
  let tmp = null;
  try {
    const dir = path.dirname(RING_TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Write+chmod atomically via a tmp file so an interrupted write cannot
    // leave a partial token or a default-permissions file on disk.
    tmp = `${RING_TOKEN_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, RING_TOKEN_FILE);
    process.env.RING_REFRESH_TOKEN = token;
  } catch (err) {
    console.error("[Ring] Failed to persist token:", err.message);
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* ignore cleanup errors */ }
    }
  }
}

function disconnect() {
  if (tokenSubscription) {
    try { tokenSubscription.unsubscribe(); } catch (err) {
      console.error("[Ring] Failed to unsubscribe:", err?.message || String(err));
    }
    tokenSubscription = null;
  }
  if (ringApi) {
    try { ringApi.disconnect(); } catch (err) {
      console.error("[Ring] Disconnect failed:", err?.message || String(err));
    }
    ringApi = null;
  }
  locations = [];
  connectionStatus = "disconnected";
}

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------

function getLocation(locationIndex = 0) {
  if (!locations[locationIndex]) throw new Error("Ring location not found");
  return locations[locationIndex];
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function withRetry(fn, label, maxAttempts = 3, delay = 2000) {
  const nonRetryable = /auth|unauthorized|401|403|not initialized|invalid/i;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message || String(err);
      if (attempt === maxAttempts || nonRetryable.test(msg)) throw err;
      console.warn(`[Ring] ${label} failed (attempt ${attempt}/${maxAttempts}): ${msg}, retrying in ${delay}ms`);
      await new Promise((r) => {
        const timer = setTimeout(r, delay);
        if (timer.unref) timer.unref();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Alarm control
// ---------------------------------------------------------------------------

async function getAlarmMode(locationIndex = 0) {
  return withRetry(async () => {
    const loc = getLocation(locationIndex);
    const devices = await withTimeout(loc.getDevices(), HUB_TIMEOUT, "getDevices");
    const panel = devices.find((d) => d.data.deviceType === RingDeviceType.SecurityPanel);
    if (!panel) throw new Error("No security panel found");
    return {
      mode: panel.data.mode, // 'all' (away) | 'some' (home) | 'none' (disarmed)
      alarmInfo: panel.data.alarmInfo,
    };
  }, "getAlarmMode");
}

async function setAlarmMode(mode, bypassZids = [], locationIndex = 0) {
  return withRetry(async () => {
    const loc = getLocation(locationIndex);
    const bypass = Array.isArray(bypassZids) ? bypassZids : [];
    switch (mode) {
      case "away":
        await withTimeout(loc.armAway(bypass), HUB_TIMEOUT, "armAway");
        break;
      case "home":
        await withTimeout(loc.armHome(bypass), HUB_TIMEOUT, "armHome");
        break;
      case "disarm":
        await withTimeout(loc.disarm(), HUB_TIMEOUT, "disarm");
        break;
      default:
        throw new Error(`Invalid mode: ${mode}. Use away|home|disarm`);
    }
    return { success: true, mode };
  }, "setAlarmMode");
}

// ---------------------------------------------------------------------------
// Siren
// ---------------------------------------------------------------------------

async function controlSiren(action, locationIndex = 0) {
  return withRetry(async () => {
    const loc = getLocation(locationIndex);
    if (action === "on") {
      await withTimeout(loc.soundSiren(), HUB_TIMEOUT, "soundSiren");
    } else if (action === "off") {
      await withTimeout(loc.silenceSiren(), HUB_TIMEOUT, "silenceSiren");
    } else {
      throw new Error(`Invalid siren action: ${action}. Use on|off`);
    }
    return { success: true, siren: action };
  }, "controlSiren");
}

// ---------------------------------------------------------------------------
// Devices / Sensors
// ---------------------------------------------------------------------------

async function getDevices(locationIndex = 0) {
  return withRetry(async () => {
    const loc = getLocation(locationIndex);
    const devices = await withTimeout(loc.getDevices(), HUB_TIMEOUT, "getDevices");
    return devices.map((d) => ({
      zid: d.data.zid,
      name: d.data.name,
      type: d.data.deviceType,
      roomId: d.data.roomId,
      faulted: d.data.faulted,
      tamperStatus: d.data.tamperStatus,
      batteryLevel: d.data.batteryLevel,
      batteryStatus: d.data.batteryStatus,
      mode: d.data.mode,
    }));
  }, "getDevices");
}

async function getSensorStatus(locationIndex = 0) {
  return withRetry(async () => {
    const devices = await getDevices(locationIndex);
    const sensorTypes = [
      RingDeviceType.ContactSensor,
      RingDeviceType.MotionSensor,
      RingDeviceType.FloodFreezeSensor,
      RingDeviceType.FreezeSensor,
      RingDeviceType.TemperatureSensor,
      RingDeviceType.WaterSensor,
      RingDeviceType.TiltSensor,
      RingDeviceType.GlassbreakSensor,
    ];
    return devices.filter((d) => sensorTypes.includes(d.type));
  }, "getSensorStatus");
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

function normalizeCameraId(cameraId) {
  return String(cameraId);
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "on") return true;
    if (lower === "false" || lower === "0" || lower === "off") return false;
  }
  return Boolean(value);
}

async function getCameras() {
  if (!ringApi) throw new Error("Ring not initialized");
  const cameras = await withTimeout(ringApi.getCameras(), CAMERA_TIMEOUT, "getCameras");
  return cameras.map((c) => ({
    id: c.id,
    name: c.name,
    model: c.model,
    hasLight: c.hasLight,
    hasSiren: c.hasSiren,
    hasBattery: c.hasBattery,
    isOffline: c.isOffline,
  }));
}

async function getCameraSnapshot(cameraId) {
  if (!ringApi) throw new Error("Ring not initialized");
  const id = normalizeCameraId(cameraId);

  // Check cache
  const cached = snapshotCache.get(id);
  if (cached && Date.now() - cached.ts < SNAPSHOT_CACHE_TTL) {
    return cached.buffer;
  }

  const cameras = await withTimeout(ringApi.getCameras(), CAMERA_TIMEOUT, "getCameras");
  const cam = cameras.find((c) => normalizeCameraId(c.id) === id);
  if (!cam) throw new Error(`Camera ${cameraId} not found`);
  const snapshot = await withTimeout(cam.getSnapshot(), CAMERA_TIMEOUT, "getSnapshot");

  // Cache result
  snapshotCache.set(id, { buffer: snapshot, ts: Date.now() });
  return snapshot; // Buffer (JPEG)
}

async function setCameraLight(cameraId, on) {
  if (!ringApi) throw new Error("Ring not initialized");
  const id = normalizeCameraId(cameraId);
  const cameras = await withTimeout(ringApi.getCameras(), CAMERA_TIMEOUT, "getCameras");
  const cam = cameras.find((c) => normalizeCameraId(c.id) === id);
  if (!cam) throw new Error(`Camera ${cameraId} not found`);
  const enabled = normalizeBoolean(on);
  await withTimeout(cam.setLight(enabled), CAMERA_TIMEOUT, "setLight");
  return { success: true, light: enabled };
}

async function setCameraSiren(cameraId, on) {
  if (!ringApi) throw new Error("Ring not initialized");
  const id = normalizeCameraId(cameraId);
  const cameras = await withTimeout(ringApi.getCameras(), CAMERA_TIMEOUT, "getCameras");
  const cam = cameras.find((c) => normalizeCameraId(c.id) === id);
  if (!cam) throw new Error(`Camera ${cameraId} not found`);
  const enabled = normalizeBoolean(on);
  await withTimeout(cam.setSiren(enabled), CAMERA_TIMEOUT, "setSiren");
  return { success: true, siren: enabled };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function getStatus() {
  return {
    connected: connectionStatus === "connected",
    status: connectionStatus,
    locationCount: locations.length,
    locations: locations.map((l) => ({
      name: l.name,
      id: l.id,
      hasHubs: l.hasHubs,
    })),
  };
}

module.exports = {
  initialize,
  loginWithEmail,
  verify2FA,
  disconnect,
  getStatus,
  getAlarmMode,
  setAlarmMode,
  controlSiren,
  getDevices,
  getSensorStatus,
  getCameras,
  getCameraSnapshot,
  setCameraLight,
  setCameraSiren,
  loadPersistedToken,
};
