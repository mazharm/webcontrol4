// ---------------------------------------------------------------------------
// c4-websocket.js – WebSocket (Socket.IO) connection to Control4 Director
// ---------------------------------------------------------------------------
//
// The Director exposes a Socket.IO server that pushes device variable-change
// events in real time.  This module wraps socket.io-client and provides a
// callback-based dispatch API keyed by device item ID.
//
// Reference: https://lawtancool.github.io/pyControl4/websocket.html
// ---------------------------------------------------------------------------

const { io } = require("socket.io-client");
const EventEmitter = require("events");

// Default token lifetime from Director is 86400s (24h).
// We refresh ~1h before expiry to be safe.
const TOKEN_REFRESH_BUFFER_S = 3600;
const TOKEN_REFRESH_RETRY_BASE_MS = 60_000;        // 1m
const TOKEN_REFRESH_RETRY_MAX_MS = 10 * 60_000;    // 10m
const TOKEN_REFRESH_MAX_RETRIES = 6;               // ~18m of retries before giving up

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap) with ±25% jitter.
// We never permanently give up — the Director may reboot for firmware
// upgrades that take longer than any finite retry budget.  Instead we raise
// `reconnectFailed` every RECONNECT_ALERT_EVERY attempts so an operator /
// health check can alert without the process abandoning recovery.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const RECONNECT_ALERT_EVERY = 20;

// Application-level heartbeat.  socket.io's transport ping detects broken
// TCP, but cannot detect a Director that silently stopped publishing (e.g.
// hung process behind a working socket).  We emit a no-op ping on our own
// schedule and force a reconnect if we haven't seen ANY traffic in the
// stall window.
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALL_TIMEOUT_MS = 90_000;   // 3x heartbeat — tolerates one missed beat

// Event deduplication — Director occasionally retransmits.  Key by
// itemId:varName:value within a short window.
const DEDUP_WINDOW_MS = 2_000;
const DEDUP_MAX_ENTRIES = 512;

class C4WebSocket extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {string}   opts.directorIp      – Director LAN IP
   * @param {string}   opts.directorToken   – Bearer token for Director
   * @param {number}   [opts.tokenValidSeconds] – token TTL in seconds
   * @param {function} [opts.refreshTokenFn] – async () => { token, validSeconds }
   * @param {function} [opts.onTokenRefresh] – ({ token, validSeconds }) => void
   * @param {function} [opts.logger]         – (...args) => void
   * @param {boolean}  [opts.rejectUnauthorized] – TLS cert validation (default false for local directors with self-signed certs)
   */
  constructor({ directorIp, directorToken, tokenValidSeconds, refreshTokenFn, onTokenRefresh, logger, rejectUnauthorized }) {
    super();
    this._directorIp = directorIp;
    this._token = directorToken;
    this._tokenValidSeconds = Number.isFinite(tokenValidSeconds) && tokenValidSeconds > 0
      ? tokenValidSeconds
      : 86400;
    this._refreshTokenFn = refreshTokenFn;
    this._onTokenRefresh = onTokenRefresh || null;
    this._logger = logger || (() => {});
    this._rejectUnauthorized = rejectUnauthorized !== undefined ? rejectUnauthorized : false;

    this._socket = null;
    this._connected = false;
    this._userDisconnected = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._tokenRefreshTimer = null;
    this._tokenRefreshRetryCount = 0;
    this._heartbeatTimer = null;
    this._lastEventAt = 0;
    this._lastTokenRefreshAt = 0;
    this._connectingPromise = null;   // in-flight connect()
    this._replacingSocket = false;    // guard against concurrent _setupSocket

    // Event dedup: Map of key → timestamp, ordered by insertion.
    this._dedup = new Map();

    // Callback registries
    this._deviceCallbacks = new Map(); // itemId -> Set<Function>
    this._anyCallbacks = new Set();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Establish Socket.IO connection to the Director.  Idempotent: if a
   *  connect is already in flight, the same promise is returned. */
  connect() {
    if (this._connectingPromise) return this._connectingPromise;
    if (this._connected) return Promise.resolve();

    this._userDisconnected = false;
    this._reconnectAttempts = 0;

    this._connectingPromise = new Promise((resolve, reject) => {
      try {
        this._setupSocket(resolve, reject);
      } catch (err) {
        reject(err);
      }
    }).finally(() => {
      this._connectingPromise = null;
    });
    return this._connectingPromise;
  }

  /** Graceful disconnect.  Idempotent. */
  disconnect() {
    this._userDisconnected = true;
    this._clearTimers();
    this._teardownSocket();
    const wasConnected = this._connected;
    this._connected = false;
    if (wasConnected) this.emit("disconnected", { reason: "user" });
    this._logger("ws-disconnected", "user-initiated");
  }

  /** Register callback for a specific device's variable changes. */
  onDeviceChange(itemId, cb) {
    const id = Number(itemId);
    if (!this._deviceCallbacks.has(id)) {
      this._deviceCallbacks.set(id, new Set());
    }
    this._deviceCallbacks.get(id).add(cb);
  }

  /** Unregister callback(s) for a device.  If cb omitted, removes all. */
  offDeviceChange(itemId, cb) {
    const id = Number(itemId);
    if (!cb) {
      this._deviceCallbacks.delete(id);
    } else {
      const cbs = this._deviceCallbacks.get(id);
      if (cbs) cbs.delete(cb);
    }
  }

  /** Register wildcard callback for ALL device changes. */
  onAnyChange(cb) {
    this._anyCallbacks.add(cb);
  }

  /** Connection status. */
  isConnected() {
    return this._connected;
  }

  /** Diagnostic snapshot — suitable for /api/health. */
  getStats() {
    return {
      connected: this._connected,
      reconnectAttempts: this._reconnectAttempts,
      lastEventAt: this._lastEventAt || null,
      lastEventAgoMs: this._lastEventAt ? Date.now() - this._lastEventAt : null,
      lastTokenRefreshAt: this._lastTokenRefreshAt || null,
      tokenRefreshRetryCount: this._tokenRefreshRetryCount,
      deviceCallbacks: this._deviceCallbacks.size,
      anyCallbacks: this._anyCallbacks.size,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: socket lifecycle
  // -------------------------------------------------------------------------

  _teardownSocket() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._socket) {
      try { this._socket.removeAllListeners(); } catch {}
      try { this._socket.disconnect(); } catch {}
      this._socket = null;
    }
  }

  _setupSocket(resolveFn, rejectFn) {
    // Guard against concurrent socket replacement (token refresh racing a
    // scheduled reconnect).  The second caller loses; the first will emit
    // `reconnected`/`connected` once settled.
    if (this._replacingSocket) {
      this._logger("ws-setup-skipped", "replacement already in progress");
      if (rejectFn) rejectFn(new Error("connect already in progress"));
      return;
    }
    this._replacingSocket = true;
    try {
      this._teardownSocket();

      const url = `https://${this._directorIp}`;
      this._logger("ws-connecting", url);

      this._socket = io(url, {
        transports: ["websocket"],
        extraHeaders: { JWT: this._token },
        rejectUnauthorized: this._rejectUnauthorized,
        reconnection: false, // we manage reconnection ourselves
        timeout: 10000,
      });

      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        resolveFn?.();
      };
      const settleErr = (err) => {
        if (settled) return;
        settled = true;
        rejectFn?.(err);
      };

      this._socket.on("connect", () => {
        this._connected = true;
        this._reconnectAttempts = 0;
        this._lastEventAt = Date.now();
        this._logger("ws-connected", url);
        this.emit("connected");
        this._startHeartbeat();
        this._scheduleTokenRefresh();
        settleOk();
      });

      // The Director pushes events on the default namespace.
      // Listen for all possible event names the Director might use.
      const eventNames = [
        "N",           // pyControl4 uses this namespace message
        "event",
        "message",
        "data",
        "deviceChange",
        "variableChange",
      ];

      for (const name of eventNames) {
        this._socket.on(name, (data) => {
          this._lastEventAt = Date.now();
          this._logger("ws-raw-event", { event: name, data });
          this._handleEvent(data);
        });
      }

      // Catch-all for unknown events (helps discover Director's event format)
      this._socket.onAny((eventName, ...args) => {
        this._lastEventAt = Date.now();
        if (!eventNames.includes(eventName) && eventName !== "connect" && eventName !== "disconnect") {
          this._logger("ws-unknown-event", { event: eventName, args });
          // Attempt to parse as device event anyway
          if (args[0] && typeof args[0] === "object") {
            this._handleEvent(args[0]);
          }
        }
      });

      this._socket.on("disconnect", (reason) => {
        this._connected = false;
        this._stopHeartbeat();
        this._logger("ws-disconnected", reason);
        this.emit("disconnected", { reason });

        if (!this._userDisconnected) {
          this._scheduleReconnect();
        }
      });

      this._socket.on("connect_error", (err) => {
        this._connected = false;
        this._stopHeartbeat();
        this._logger("ws-connect-error", err.message);
        this.emit("error", err);

        // Only reject the caller's promise on the very first attempt.
        // Subsequent errors trigger reconnect; rejecting would leak an
        // unhandled rejection into the caller's already-resolved context.
        if (this._reconnectAttempts === 0) {
          settleErr(err);
        }

        if (!this._userDisconnected) {
          this._scheduleReconnect();
        }
      });
    } finally {
      this._replacingSocket = false;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: heartbeat / stall detection
  // -------------------------------------------------------------------------

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected || !this._socket) return;

      // Fire a ping with ack-timeout.  If the Director doesn't respond
      // *and* we've seen no other traffic for STALL_TIMEOUT_MS, force a
      // reconnect — the connection is dead but has not surfaced as such.
      try {
        this._socket.timeout(HEARTBEAT_INTERVAL_MS).emit("ping", () => {
          this._lastEventAt = Date.now();
        });
      } catch (err) {
        this._logger("ws-heartbeat-emit-error", err.message);
      }

      const stale = Date.now() - (this._lastEventAt || 0);
      if (stale > STALL_TIMEOUT_MS) {
        this._logger("ws-stall-detected", `${Math.round(stale / 1000)}s without traffic`);
        this._stopHeartbeat();
        // Force-close the socket; the `disconnect` handler will reconnect.
        try { this._socket && this._socket.disconnect(); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  // -------------------------------------------------------------------------
  // Internal: event handling + dedup
  // -------------------------------------------------------------------------

  _isDuplicate(payload) {
    const key = `${payload.itemId}:${payload.varName}:${payload.value}`;
    const now = payload.timestamp;

    // Evict expired entries
    for (const [k, ts] of this._dedup) {
      if (now - ts > DEDUP_WINDOW_MS) this._dedup.delete(k);
    }
    if (this._dedup.has(key)) return true;
    this._dedup.set(key, now);
    // Evict oldest entries when over capacity
    if (this._dedup.size > DEDUP_MAX_ENTRIES) {
      const firstKey = this._dedup.keys().next().value;
      this._dedup.delete(firstKey);
    }
    return false;
  }

  _handleEvent(data) {
    // The Director may send a single object or an array of objects
    const events = Array.isArray(data) ? data : [data];

    for (const evt of events) {
      if (!evt || typeof evt !== "object") continue;

      // Normalize: the Director uses iddevice for the device ID.
      // Variable changes may come as individual fields or as a varName/value pair.
      const itemId = Number(evt.iddevice || evt.itemId || evt.id);
      if (!itemId || !Number.isFinite(itemId)) continue;

      // Extract variable changes — try multiple formats
      const changes = [];

      // Format 1: { iddevice, varName, value }
      if (evt.varName !== undefined) {
        changes.push({ varName: evt.varName, value: evt.value });
      }

      // Format 2: { iddevice, changes: [{ varName, value }, ...] }
      if (Array.isArray(evt.changes)) {
        for (const c of evt.changes) {
          if (c.varName !== undefined) {
            changes.push({ varName: c.varName, value: c.value });
          }
        }
      }

      // Format 3: { iddevice, LIGHT_LEVEL: 50, ... } — variable names as keys
      if (changes.length === 0) {
        for (const [key, val] of Object.entries(evt)) {
          if (key === "iddevice" || key === "idparent" || key === "itemId" || key === "id") continue;
          if (key.startsWith("_")) continue;
          // Assume uppercase keys are variable names
          if (key === key.toUpperCase() && key.length > 1) {
            changes.push({ varName: key, value: val });
          }
        }
      }

      for (const { varName, value } of changes) {
        const payload = {
          itemId,
          varName: String(varName),
          value,
          timestamp: Date.now(),
          raw: evt,
        };

        if (this._isDuplicate(payload)) {
          this._logger("ws-event-duplicate", { itemId, varName });
          continue;
        }

        // Per-device callbacks
        const cbs = this._deviceCallbacks.get(itemId);
        if (cbs) {
          for (const cb of cbs) {
            try { cb(payload); } catch (err) {
              this._logger("ws-callback-error", err.message);
            }
          }
        }

        // Wildcard callbacks
        for (const cb of this._anyCallbacks) {
          try { cb(payload); } catch (err) {
            this._logger("ws-any-callback-error", err.message);
          }
        }

        // EventEmitter
        this.emit("deviceChange", payload);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: token refresh
  // -------------------------------------------------------------------------

  _scheduleTokenRefresh() {
    if (this._tokenRefreshTimer) clearTimeout(this._tokenRefreshTimer);
    if (!this._refreshTokenFn) return;

    // Refresh ~1h before expiry.  Default Director token = 86400s → refresh at ~82800s (23h)
    const refreshMs = Math.max(60, this._tokenValidSeconds - TOKEN_REFRESH_BUFFER_S) * 1000;
    // Add jitter: ±5 minutes (reduces correlated refresh storms across replicas)
    const jitter = (Math.random() - 0.5) * 10 * 60 * 1000;
    const delay = Math.max(60_000, refreshMs + jitter); // at least 1 minute

    this._tokenRefreshRetryCount = 0;
    this._logger("ws-token-refresh-scheduled", `in ${Math.round(delay / 60000)}m`);

    this._tokenRefreshTimer = setTimeout(() => this._refreshToken(), delay);
    if (this._tokenRefreshTimer.unref) this._tokenRefreshTimer.unref();
  }

  async _refreshToken() {
    try {
      this._logger("ws-token-refreshing");
      const { token, validSeconds } = await this._refreshTokenFn();
      this._token = token;
      if (Number.isFinite(validSeconds) && validSeconds > 0) {
        this._tokenValidSeconds = validSeconds;
      }
      this._lastTokenRefreshAt = Date.now();
      this._tokenRefreshRetryCount = 0;
      if (this._onTokenRefresh) {
        try {
          this._onTokenRefresh({ token, validSeconds });
        } catch (err) {
          this._logger("ws-token-refresh-callback-error", err.message);
        }
      }
      this._logger("ws-token-refreshed", "reconnecting with new token");

      // Reconnect with the new token.  Use the reconnect path so
      // replacement goes through the same guard as regular reconnects.
      this._setupSocket(
        () => this.emit("reconnected"),
        (err) => this._logger("ws-token-refresh-reconnect-error", err.message)
      );

      // Schedule the next refresh at the full 23h interval.
      this._scheduleTokenRefresh();
    } catch (err) {
      this._tokenRefreshRetryCount++;
      this._logger("ws-token-refresh-error", {
        error: err.message,
        retry: this._tokenRefreshRetryCount,
      });

      if (this._tokenRefreshRetryCount >= TOKEN_REFRESH_MAX_RETRIES) {
        this._logger("ws-token-refresh-gave-up", "falling back to full 23h reschedule");
        this._tokenRefreshRetryCount = 0;
        this.emit("tokenRefreshFailed");
        this._scheduleTokenRefresh();
        return;
      }

      // Bounded exponential backoff for retries.
      const delay = Math.min(
        TOKEN_REFRESH_RETRY_BASE_MS * Math.pow(2, this._tokenRefreshRetryCount - 1),
        TOKEN_REFRESH_RETRY_MAX_MS
      );
      if (this._tokenRefreshTimer) clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = setTimeout(() => this._refreshToken(), delay);
      if (this._tokenRefreshTimer.unref) this._tokenRefreshTimer.unref();
    }
  }

  // -------------------------------------------------------------------------
  // Internal: reconnect
  // -------------------------------------------------------------------------

  _scheduleReconnect() {
    if (this._userDisconnected) return;
    if (this._reconnectTimer) return; // already scheduled

    this._reconnectAttempts++;

    // Bounded exponential backoff with ±25% jitter.  Never give up — a
    // Director firmware upgrade can take longer than any finite budget.
    const n = Math.min(this._reconnectAttempts - 1, 10);
    const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, n), BACKOFF_MAX_MS);
    const delay = Math.floor(base * (0.75 + Math.random() * 0.5));

    // Surface a persistent outage via a periodic event for alerting.
    if (this._reconnectAttempts % RECONNECT_ALERT_EVERY === 0) {
      this._logger("ws-reconnect-still-failing", { attempts: this._reconnectAttempts });
      this.emit("reconnectFailed", { attempts: this._reconnectAttempts });
    }

    this._logger("ws-reconnecting", { attempt: this._reconnectAttempts, delayMs: delay });
    this.emit("reconnecting", { attempt: this._reconnectAttempts, delay });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._setupSocket(
        () => this.emit("reconnected"),
        () => {} // swallow reject; `connect_error` will re-schedule
      );
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _clearTimers() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._tokenRefreshTimer) { clearTimeout(this._tokenRefreshTimer); this._tokenRefreshTimer = null; }
    this._stopHeartbeat();
  }
}

module.exports = { C4WebSocket };
