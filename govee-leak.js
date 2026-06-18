// ---------------------------------------------------------------------------
// Govee Leak Sensor Module
// Polls Govee's undocumented cloud API for water leak sensor status.
// ---------------------------------------------------------------------------

const https = require("https");
const crypto = require("crypto");

// UUID v5 (SHA-1 name-based) — matches the Govee app's client ID generation.
// Namespace: DNS (6ba7b810-9dad-11d1-80b4-00c04fd430c8)
const UUID_NS_DNS = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
function uuidv5(name) {
  const hash = crypto.createHash("sha1");
  hash.update(UUID_NS_DNS);
  hash.update(name);
  const bytes = hash.digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC4122
  const hex = bytes.slice(0, 16).toString("hex");
  // Return without hyphens (simple format) to match Govee expectations
  return hex;
}

const LEAK_SKUS = ["H5054", "H5058", "H5059", "H5040", "H5043", "H5072"];
const TOKEN_MAX_AGE_MS = 23 * 60 * 60 * 1000; // 23 hours
const MIN_POLL_INTERVAL = 30;
const MAX_POLL_INTERVAL = 300; // 5 minutes
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 512 * 1024;

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  appVersion: "6.3.0",
  clientType: "1",
  iotVersion: "0",
  "User-Agent":
    "GoveeHome/6.3.0 (com.ihoment.GoVeeSensor; build:2; iOS 17.0.0) Alamofire/5.6.4",
};

function normalizePollInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.max(MIN_POLL_INTERVAL, Math.min(Math.floor(n), MAX_POLL_INTERVAL));
}

// ---------------------------------------------------------------------------
// Minimal HTTPS JSON request helper (no external deps)
// ---------------------------------------------------------------------------

function request(method, url, body, extraHeaders, { skipDefaults = false } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : null;

    const headers = skipDefaults
      ? { "Content-Type": "application/json", ...extraHeaders }
      : { ...DEFAULT_HEADERS, ...extraHeaders };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(
      parsed,
      { method, headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        let raw = "";
        let received = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          received += Buffer.byteLength(chunk);
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Govee response too large"));
            return;
          }
          raw += chunk;
        });
        res.on("end", () => {
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            return reject(new Error(`Non-JSON response from Govee (HTTP ${res.statusCode})`));
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// GoveeLeak class
// ---------------------------------------------------------------------------

class GoveeLeak {
  /**
   * @param {object} opts
   * @param {string} opts.email           – Govee account email (for clientId)
   * @param {string} opts.token           – Pre-authenticated bearer token
   * @param {number} [opts.tokenTimestamp] – When the token was obtained (epoch ms)
   * @param {number} [opts.pollInterval]  – Poll interval in seconds (min 30, default 60)
   * @param {function} [opts.onLeakEvent] – Called on leak state changes / active leaks
   * @param {function} [opts.onDevicesReady] – Called after device discovery
   * @param {function} [opts.onTokenExpired] – Called when token expires and re-auth is needed
   * @param {object} [opts.log]           – Logger with info/warn/error methods
   */
  constructor(opts) {
    this.email = opts.email;
    this.pollInterval = normalizePollInterval(opts.pollInterval);
    this.onLeakEvent = opts.onLeakEvent || (() => {});
    this.onDevicesReady = opts.onDevicesReady || (() => {});
    this.onTokenExpired = opts.onTokenExpired || (() => {});
    this.log = opts.log || console;

    this.clientId = uuidv5(this.email);
    this.token = opts.token || null;
    this.tokenTimestamp = opts.tokenTimestamp || (opts.token ? Date.now() : 0);
    this.needsReauth = false;
    this.devices = new Map();
    this._pollTimer = null;
    this._retryTimer = null;
    this._pollInFlight = false;
    this._running = false;
    this._runId = 0;
    this._currentPollInterval = this.pollInterval;
  }

  // -----------------------------------------------------------------------
  // Static login — authenticate with email/password, return token info.
  // Password is NOT stored on the instance.
  // -----------------------------------------------------------------------

  static async login(email, password) {
    const clientId = uuidv5(email);

    // Login request uses NO custom headers — only Content-Type: application/json
    // (matches govee2mqtt behavior; extra app headers cause 454 rejections)
    const res = await request(
      "POST",
      "https://app2.govee.com/account/rest/account/v1/login",
      { email, password, client: clientId },
      {},
      { skipDefaults: true }
    );

    if (res.status === 451) {
      throw new Error("Govee account not found or regional restriction");
    }

    const d = res.data;

    // Govee uses internal status codes in the JSON body
    const goveeStatus = d?.status;
    if (goveeStatus && goveeStatus !== 200) {
      const msg = d?.message || d?.msg || "";
      throw new Error(`Govee login failed (code ${goveeStatus}): ${msg || "unexpected response"}`);
    }

    const client = d?.client || d?.data?.client;
    const token = client?.token || client?.A || client?.B;
    if (!token) {
      throw new Error("Govee login failed: unexpected response");
    }

    return {
      token,
      clientId,
      email,
      tokenTimestamp: Date.now(),
    };
  }

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  _emitTokenExpired() {
    try {
      this.onTokenExpired();
    } catch (err) {
      this.log.error(`[govee] onTokenExpired callback failed: ${err?.message || String(err)}`);
    }
  }

  _emitDevicesReady(sensors) {
    try {
      this.onDevicesReady(sensors);
    } catch (err) {
      this.log.error(`[govee] onDevicesReady callback failed: ${err?.message || String(err)}`);
    }
  }

  _emitLeakEvent(event) {
    try {
      this.onLeakEvent(event);
    } catch (err) {
      this.log.error(`[govee] onLeakEvent callback failed: ${err?.message || String(err)}`);
    }
  }

  _checkToken() {
    if (!this.token) {
      this.needsReauth = true;
      this._emitTokenExpired();
      throw new Error("Govee token not available — re-authentication required");
    }
    if (Date.now() - this.tokenTimestamp > TOKEN_MAX_AGE_MS) {
      this.needsReauth = true;
      this.token = null;
      this._emitTokenExpired();
      throw new Error("Govee token expired — re-authentication required");
    }
  }

  /** Update the token (e.g. after a fresh login). Clears needsReauth. */
  setToken(token, timestamp) {
    this.token = token;
    this.tokenTimestamp = timestamp || Date.now();
    this.needsReauth = false;
  }

  _commonHeaders() {
    const headers = {
      clientId: this.clientId,
      timestamp: String(Date.now()),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  async _apiRequest(method, url, body) {
    this._checkToken();
    const res = await request(method, url, body, this._commonHeaders());
    // If Govee returns 401, mark as needing re-auth
    if (res.status === 401) {
      this.needsReauth = true;
      this.token = null;
      this._emitTokenExpired();
      throw new Error("Govee token rejected — re-authentication required");
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Govee API returned HTTP ${res.status}`);
    }
    return res;
  }

  // -----------------------------------------------------------------------
  // Device Discovery
  // -----------------------------------------------------------------------

  async discoverDevices() {
    const res = await this._apiRequest(
      "POST",
      "https://app2.govee.com/device/rest/devices/v1/list",
      {}
    );

    const deviceListRaw = res.data?.devices || res.data?.data?.devices || [];
    const deviceList = Array.isArray(deviceListRaw) ? deviceListRaw : [];
    this.log.info(`[govee] Device list response: ${deviceList.length} total device(s)`);
    for (const d of deviceList) {
      if (!d || typeof d !== "object") continue;
      this.log.info(`[govee]   - ${d.deviceName || d.device} (sku: ${d.sku}, type: ${d.deviceType || "?"})`);
    }
    let found = 0;
    const seen = new Set();

    for (const d of deviceList) {
      if (!d || typeof d !== "object" || typeof d.device !== "string" || !d.device) continue;
      if (!LEAK_SKUS.includes(d.sku)) continue;
      found++;
      seen.add(d.device);

      const existing = this.devices.get(d.device);
      this.devices.set(d.device, {
        sku: d.sku,
        name: d.deviceName || d.device,
        leakDetected: existing?.leakDetected || false,
        battery: existing?.battery ?? this._parseBattery(d),
        online: existing?.online ?? null,
        gwOnline: existing?.gwOnline ?? null,
        lastTime: existing?.lastTime ?? null,
      });
    }

    for (const id of this.devices.keys()) {
      if (!seen.has(id)) this.devices.delete(id);
    }

    this.log.info(`[govee] Discovered ${found} leak sensor(s)`);
    this._emitDevicesReady(this.getState().sensors);
    return found;
  }

  _parseBattery(device) {
    try {
      const ext = device.deviceExt;
      if (!ext?.deviceSettings) return null;
      const settings =
        typeof ext.deviceSettings === "string"
          ? JSON.parse(ext.deviceSettings)
          : ext.deviceSettings;
      return typeof settings.battery === "number" ? settings.battery : null;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Leak Status Polling
  // -----------------------------------------------------------------------

  async pollLeakStatus() {
    // Guard against overlapping polls: if a cycle runs longer than the poll
    // interval, a second setInterval tick must not start a concurrent sweep
    // (which would double API usage and can reorder state updates).
    if (this._pollInFlight) return;
    this._pollInFlight = true;
    try {
      await this._pollLeakStatusInner();
    } finally {
      this._pollInFlight = false;
    }
  }

  async _pollLeakStatusInner() {
    for (const [deviceId, state] of this.devices) {
      try {
        const res = await this._apiRequest(
          "POST",
          "https://app2.govee.com/leak/rest/device/v1/warnMessage",
          { device: deviceId, sku: state.sku }
        );

        // Check rate limit headers
        const remaining = res.headers?.["x-ratelimit-remaining"];
        if (remaining !== undefined) {
          const rem = parseInt(remaining, 10);
          if (rem <= 5) {
            this.log.warn(`[govee] Rate limit low: ${rem} remaining`);
          }
          if (rem <= 0) {
            this._backoff();
            return;
          }
        }

        const parsed = this._parseLeakResponse(res.data);
        if (!parsed) {
          this.log.warn(`[govee] Could not parse response for ${state.name}`);
          continue;
        }

        const prevLeak = state.leakDetected;
        state.leakDetected = parsed.leakDetected;
        if (parsed.battery !== null) state.battery = parsed.battery;
        if (parsed.online !== null) state.online = parsed.online;
        if (parsed.gwOnline !== null) state.gwOnline = parsed.gwOnline;
        if (parsed.lastTime !== null) state.lastTime = parsed.lastTime;

        // Emit if state changed OR if leak is currently active (safety: re-emit)
        const stateChanged = prevLeak !== parsed.leakDetected;
        if (stateChanged || parsed.leakDetected) {
          this._emitLeakEvent({
            device: deviceId,
            name: state.name,
            sku: state.sku,
            leakDetected: parsed.leakDetected,
            battery: state.battery,
            online: state.online,
            gwOnline: state.gwOnline,
            lastTime: state.lastTime,
            timestamp: new Date().toISOString(),
            raw: res.data,
          });
        }
      } catch (err) {
        // If token expired, stop polling — don't keep hammering
        if (this.needsReauth) {
          this.log.warn("[govee] Token expired, stopping poll cycle");
          this._stopPollTimer();
          return;
        }
        this.log.error(`[govee] Poll failed for ${state.name}: ${err.message}`);
        // Continue to next device
      }
    }

    // Reset poll interval on success
    if (this._currentPollInterval > this.pollInterval) {
      this._currentPollInterval = this.pollInterval;
      this._restartPollTimer();
    }
  }

  _parseLeakResponse(data) {
    if (!data) return null;

    try {
      // Unwrap nested data wrapper (Shape C)
      const d = data.data || data;

      let leakDetected = false;
      let battery = null;
      let online = null;
      let gwOnline = null;
      let lastTime = null;

      // Check top-level booleans
      if (typeof d.leakDetected === "boolean") leakDetected = d.leakDetected;
      if (typeof d.leak === "boolean") leakDetected = d.leak;
      if (typeof d.warning === "boolean") leakDetected = d.warning;

      // Extract top-level fields
      if (typeof d.battery === "number") battery = d.battery;
      if (typeof d.online === "boolean") online = d.online;
      if (typeof d.gwonline === "boolean") gwOnline = d.gwonline;
      if (typeof d.gwOnline === "boolean") gwOnline = d.gwOnline;
      if (typeof d.lastTime === "number") lastTime = d.lastTime;

      // Check array fields (Shape B)
      const messages = d.warnMessage || d.messages || d.warnMessages;
      if (Array.isArray(messages) && messages.length > 0) {
        // Sort by time descending, use latest
        const sorted = [...messages].sort(
          (a, b) => (b.lastTime || 0) - (a.lastTime || 0)
        );
        const latest = sorted[0];

        if (typeof latest.leakDetected === "boolean") {
          leakDetected = latest.leakDetected;
        } else if (typeof latest.leak === "boolean") {
          leakDetected = latest.leak;
        }
        // read: false on latest message = active/unacknowledged leak
        if (latest.read === false) leakDetected = true;

        if (typeof latest.battery === "number") battery = latest.battery;
        if (typeof latest.lastTime === "number") lastTime = latest.lastTime;
      }

      // Handle string-valued fields (double-encoded JSON)
      if (typeof d.deviceSettings === "string") {
        try {
          const settings = JSON.parse(d.deviceSettings);
          if (typeof settings.battery === "number") battery = settings.battery;
        } catch { /* ignore */ }
      }

      return { leakDetected, battery, online, gwOnline, lastTime };
    } catch {
      return null;
    }
  }

  _backoff() {
    this._currentPollInterval = Math.min(
      this._currentPollInterval * 2,
      MAX_POLL_INTERVAL
    );
    this.log.warn(
      `[govee] Rate limited, backing off to ${this._currentPollInterval}s`
    );
    this._restartPollTimer();
  }

  _stopPollTimer() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _restartPollTimer() {
    this._stopPollTimer();
    if (this._running) {
      this._pollTimer = setInterval(
        () => this.pollLeakStatus().catch((e) => this.log.error("[govee] Poll error:", e.message)),
        this._currentPollInterval * 1000
      );
      if (this._pollTimer.unref) this._pollTimer.unref();
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start() {
    if (this._running) {
      await this.stop();
    }
    this._running = true;
    const runId = ++this._runId;

    const tryDiscover = async () => {
      try {
        const count = await this.discoverDevices();
        if (!this._running || this._runId !== runId) return;
        if (count === 0) {
          this.log.warn("[govee] No leak sensors found, retrying in 5 minutes");
          this._retryTimer = setTimeout(() => {
            if (this._running && this._runId === runId) tryDiscover();
          }, 5 * 60 * 1000);
          if (this._retryTimer.unref) this._retryTimer.unref();
          return;
        }
        // Initial poll
        await this.pollLeakStatus();
        if (!this._running || this._runId !== runId) return;
        // Start polling interval
        this._stopPollTimer();
        this._pollTimer = setInterval(
          () => this.pollLeakStatus().catch((e) => this.log.error("[govee] Poll error:", e.message)),
          this._currentPollInterval * 1000
        );
        if (this._pollTimer.unref) this._pollTimer.unref();
      } catch (err) {
        if (!this._running || this._runId !== runId) return;
        if (this.needsReauth) {
          this.log.warn("[govee] Token expired during startup — waiting for re-auth");
          return;
        }
        this.log.error(`[govee] Discovery failed: ${err.message}, retrying in 30s`);
        this._retryTimer = setTimeout(() => {
          if (this._running && this._runId === runId) tryDiscover();
        }, 30000);
        if (this._retryTimer.unref) this._retryTimer.unref();
      }
    };

    await tryDiscover();
  }

  async stop() {
    this._running = false;
    this._runId++;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._stopPollTimer();
  }

  getState() {
    const sensors = [];
    let anyLeak = false;

    for (const [id, s] of this.devices) {
      if (s.leakDetected) anyLeak = true;
      sensors.push({
        id,
        name: s.name,
        sku: s.sku,
        leakDetected: s.leakDetected,
        battery: s.battery,
        online: s.online,
        gwOnline: s.gwOnline,
        lastTime: s.lastTime,
      });
    }

    return {
      sensorCount: sensors.length,
      anyLeak,
      needsReauth: this.needsReauth,
      sensors,
    };
  }
}

module.exports = GoveeLeak;
