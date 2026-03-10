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

// Snapshot cache: cameraId -> { buffer, ts }
const snapshotCache = new Map();
const SNAPSHOT_CACHE_TTL = 10_000; // 10 seconds

// Pending login state for email/password + 2FA flow
let pendingLogin = null; // { email, password, hardwareId }

// ---------------------------------------------------------------------------
// Ring OAuth token request (direct HTTP, no library internals needed)
// ---------------------------------------------------------------------------

function ringOAuthRequest(grantData, hardwareId, twoFactorCode) {
  return new Promise((resolve, reject) => {
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
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200) {
              resolve({ success: true, data: json });
            } else if (res.statusCode === 412) {
              // 2FA required
              const prompt = json.tsv_state === "totp"
                ? "Enter the code from your authenticator app"
                : `Enter the code sent to ${json.phone || "your device"} via ${json.tsv_state || "SMS"}`;
              resolve({ success: false, requires2FA: true, prompt });
            } else if (res.statusCode === 400 && typeof json.error === "string" && json.error.startsWith("Verification Code")) {
              resolve({ success: false, requires2FA: true, prompt: "Invalid code. Please try again." });
            } else {
              const msg = json.error_description || json.error || `HTTP ${res.statusCode}`;
              resolve({ success: false, error: msg });
            }
          } catch {
            resolve({ success: false, error: `Unexpected response (HTTP ${res.statusCode})` });
          }
        });
      }
    );

    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

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
    pendingLogin = { email, password, hardwareId };
    return result;
  }

  if (!result.success) return result;

  // Got a refresh token directly (no 2FA)
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

  pendingLogin = null;
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
  connectionStatus = "connecting";
  try {
    ringApi = new RingApi({
      refreshToken,
      cameraStatusPollingSeconds: 30,
      cameraDingsPollingSeconds: 5,
    });

    // Persist rotated refresh tokens
    ringApi.onRefreshTokenUpdated.subscribe({
      next: ({ newRefreshToken }) => {
        persistToken(newRefreshToken);
      },
    });

    locations = await ringApi.getLocations();
    connectionStatus = "connected";
    console.log(`[Ring] Connected. ${locations.length} location(s) found.`);
    return { success: true, locationCount: locations.length };
  } catch (err) {
    connectionStatus = "error";
    console.error("[Ring] Init failed:", err.message);
    return { success: false, error: err.message };
  }
}

function persistToken(token) {
  const envPath = path.resolve(__dirname, ".env");
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    if (content.includes("RING_REFRESH_TOKEN=")) {
      content = content.replace(/RING_REFRESH_TOKEN=.*/, `RING_REFRESH_TOKEN=${token}`);
    } else {
      content += `\nRING_REFRESH_TOKEN=${token}\n`;
    }
    fs.writeFileSync(envPath, content);
    process.env.RING_REFRESH_TOKEN = token;
  } catch (err) {
    console.error("[Ring] Failed to persist token:", err.message);
  }
}

function disconnect() {
  if (ringApi) {
    ringApi.disconnect();
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

// ---------------------------------------------------------------------------
// Alarm control
// ---------------------------------------------------------------------------

async function getAlarmMode(locationIndex = 0) {
  const loc = getLocation(locationIndex);
  const devices = await loc.getDevices();
  const panel = devices.find((d) => d.data.deviceType === RingDeviceType.SecurityPanel);
  if (!panel) throw new Error("No security panel found");
  return {
    mode: panel.data.mode, // 'all' (away) | 'some' (home) | 'none' (disarmed)
    alarmInfo: panel.data.alarmInfo,
  };
}

async function setAlarmMode(mode, bypassZids = [], locationIndex = 0) {
  const loc = getLocation(locationIndex);
  switch (mode) {
    case "away":
      await loc.armAway(bypassZids);
      break;
    case "home":
      await loc.armHome(bypassZids);
      break;
    case "disarm":
      await loc.disarm();
      break;
    default:
      throw new Error(`Invalid mode: ${mode}. Use away|home|disarm`);
  }
  return { success: true, mode };
}

// ---------------------------------------------------------------------------
// Siren
// ---------------------------------------------------------------------------

async function controlSiren(action, locationIndex = 0) {
  const loc = getLocation(locationIndex);
  if (action === "on") await loc.soundSiren();
  if (action === "off") await loc.silenceSiren();
  return { success: true, siren: action };
}

// ---------------------------------------------------------------------------
// Devices / Sensors
// ---------------------------------------------------------------------------

async function getDevices(locationIndex = 0) {
  const loc = getLocation(locationIndex);
  const devices = await loc.getDevices();
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
}

async function getSensorStatus(locationIndex = 0) {
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
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

async function getCameras() {
  if (!ringApi) throw new Error("Ring not initialized");
  const cameras = await ringApi.getCameras();
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

  // Check cache
  const cached = snapshotCache.get(cameraId);
  if (cached && Date.now() - cached.ts < SNAPSHOT_CACHE_TTL) {
    return cached.buffer;
  }

  const cameras = await ringApi.getCameras();
  const cam = cameras.find((c) => c.id === cameraId);
  if (!cam) throw new Error(`Camera ${cameraId} not found`);
  const snapshot = await cam.getSnapshot();

  // Cache result
  snapshotCache.set(cameraId, { buffer: snapshot, ts: Date.now() });
  return snapshot; // Buffer (JPEG)
}

async function setCameraLight(cameraId, on) {
  if (!ringApi) throw new Error("Ring not initialized");
  const cameras = await ringApi.getCameras();
  const cam = cameras.find((c) => c.id === cameraId);
  if (!cam) throw new Error(`Camera ${cameraId} not found`);
  await cam.setLight(on);
  return { success: true, light: on };
}

async function setCameraSiren(cameraId, on) {
  if (!ringApi) throw new Error("Ring not initialized");
  const cameras = await ringApi.getCameras();
  const cam = cameras.find((c) => c.id === cameraId);
  if (!cam) throw new Error(`Camera ${cameraId} not found`);
  await cam.setSiren(on);
  return { success: true, siren: on };
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
};
