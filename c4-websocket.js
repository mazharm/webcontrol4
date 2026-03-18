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

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap)
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 20;

class C4WebSocket extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {string}   opts.directorIp      – Director LAN IP
   * @param {string}   opts.directorToken   – Bearer token for Director
   * @param {function} [opts.refreshTokenFn] – async () => { token, validSeconds }
   * @param {function} [opts.logger]         – (...args) => void
   * @param {boolean}  [opts.rejectUnauthorized] – TLS cert validation (default false for local directors with self-signed certs)
   */
  constructor({ directorIp, directorToken, refreshTokenFn, logger, rejectUnauthorized }) {
    super();
    this._directorIp = directorIp;
    this._token = directorToken;
    this._refreshTokenFn = refreshTokenFn;
    this._logger = logger || (() => {});
    this._rejectUnauthorized = rejectUnauthorized !== undefined ? rejectUnauthorized : false;

    this._socket = null;
    this._connected = false;
    this._userDisconnected = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._tokenRefreshTimer = null;

    // Callback registries
    this._deviceCallbacks = new Map(); // itemId -> Set<Function>
    this._anyCallbacks = new Set();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Establish Socket.IO connection to the Director. */
  connect() {
    return new Promise((resolve, reject) => {
      this._userDisconnected = false;
      this._reconnectAttempts = 0;

      try {
        this._setupSocket(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Graceful disconnect. */
  disconnect() {
    this._userDisconnected = true;
    this._clearTimers();
    if (this._socket) {
      this._socket.disconnect();
      this._socket.removeAllListeners();
      this._socket = null;
    }
    this._connected = false;
    this.emit("disconnected", { reason: "user" });
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

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  _setupSocket(resolveFn, rejectFn) {
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.disconnect();
    }

    const url = `https://${this._directorIp}`;
    this._logger("ws-connecting", url);

    this._socket = io(url, {
      transports: ["websocket"],
      extraHeaders: { JWT: this._token },
      rejectUnauthorized: this._rejectUnauthorized,
      reconnection: false, // we manage reconnection ourselves
      timeout: 10000,
    });

    let resolved = false;

    this._socket.on("connect", () => {
      this._connected = true;
      this._reconnectAttempts = 0;
      this._logger("ws-connected", url);
      this.emit("connected");
      this._scheduleTokenRefresh();

      if (!resolved) {
        resolved = true;
        resolveFn?.();
      }
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
        this._logger("ws-raw-event", { event: name, data });
        this._handleEvent(data);
      });
    }

    // Catch-all for unknown events (helps discover Director's event format)
    this._socket.onAny((eventName, ...args) => {
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
      this._logger("ws-disconnected", reason);
      this.emit("disconnected", { reason });

      if (!this._userDisconnected) {
        this._scheduleReconnect();
      }
    });

    this._socket.on("connect_error", (err) => {
      this._connected = false;
      this._logger("ws-connect-error", err.message);
      this.emit("error", err);

      if (!resolved) {
        resolved = true;
        // Don't reject on first connect — schedule reconnect instead
        // Only reject if we've never connected
        if (this._reconnectAttempts === 0 && rejectFn) {
          rejectFn(err);
        }
      }

      if (!this._userDisconnected) {
        this._scheduleReconnect();
      }
    });
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

  _scheduleTokenRefresh() {
    if (this._tokenRefreshTimer) clearTimeout(this._tokenRefreshTimer);
    if (!this._refreshTokenFn) return;

    // Refresh ~1h before expiry.  Default Director token = 86400s → refresh at ~82800s (23h)
    const refreshMs = (86400 - TOKEN_REFRESH_BUFFER_S) * 1000;
    // Add jitter: ±5 minutes
    const jitter = (Math.random() - 0.5) * 10 * 60 * 1000;
    const delay = Math.max(60000, refreshMs + jitter); // at least 1 minute

    this._logger("ws-token-refresh-scheduled", `in ${Math.round(delay / 60000)}m`);

    this._tokenRefreshTimer = setTimeout(async () => {
      try {
        this._logger("ws-token-refreshing");
        const { token } = await this._refreshTokenFn();
        this._token = token;
        this._logger("ws-token-refreshed", "reconnecting with new token");

        // Disconnect and reconnect with new token
        if (this._socket) {
          this._socket.disconnect();
          this._socket.removeAllListeners();
          this._socket = null;
        }
        this._connected = false;

        this._setupSocket(
          () => this.emit("reconnected"),
          (err) => this._logger("ws-token-refresh-reconnect-error", err.message)
        );
      } catch (err) {
        this._logger("ws-token-refresh-error", err.message);
        // Try again in 5 minutes — clear existing timer first to prevent leaks
        if (this._tokenRefreshTimer) clearTimeout(this._tokenRefreshTimer);
        this._tokenRefreshTimer = setTimeout(() => this._scheduleTokenRefresh(), 5 * 60 * 1000);
      }
    }, delay);

    if (this._tokenRefreshTimer.unref) this._tokenRefreshTimer.unref();
  }

  _scheduleReconnect() {
    if (this._userDisconnected) return;
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._logger("ws-reconnect-exhausted", `gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      this.emit("reconnectFailed");
      return;
    }

    const delay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this._reconnectAttempts),
      BACKOFF_MAX_MS
    );
    this._reconnectAttempts++;

    this._logger("ws-reconnecting", { attempt: this._reconnectAttempts, delayMs: delay });
    this.emit("reconnecting", { attempt: this._reconnectAttempts, delay });

    this._reconnectTimer = setTimeout(() => {
      this._setupSocket(
        () => this.emit("reconnected"),
        () => {} // swallow reject, _scheduleReconnect will be called again on error
      );
    }, delay);

    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _clearTimers() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._tokenRefreshTimer) { clearTimeout(this._tokenRefreshTimer); this._tokenRefreshTimer = null; }
  }
}

module.exports = { C4WebSocket };
