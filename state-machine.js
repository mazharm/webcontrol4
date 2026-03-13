// ---------------------------------------------------------------------------
// state-machine.js – In-memory device state + derived home state engine
// ---------------------------------------------------------------------------
//
// Maintains a normalised representation of every discovered Control4 device,
// grouped by room.  Updated in real time via WebSocket events (or polling
// fallback).  Exposes a compact summary suitable for LLM context windows.
// ---------------------------------------------------------------------------

const EventEmitter = require("events");

// -------------------------------------------------------------------------
// Device categories and the variables we care about per type
// -------------------------------------------------------------------------

const DEVICE_TYPES = {
  light:      { category: "lights",       vars: ["LIGHT_LEVEL", "LIGHT_STATE"] },
  thermostat: { category: "thermostats",  vars: ["TEMPERATURE_F", "HEAT_SETPOINT_F", "COOL_SETPOINT_F", "HVAC_MODE", "HUMIDITY", "HVAC_STATE", "FAN_MODE"] },
  lock:       { category: "locks",        vars: ["LOCK_STATE", "LAST_ACTION", "BATTERY_LEVEL"] },
  sensor:     { category: "sensors",      vars: ["CONTACT_STATE", "MOTION_STATE", "MOTION_DETECTED", "LIGHT_LEVEL"] },
  security:   { category: "security",     vars: ["PARTITION_STATE", "ALARM_TYPE", "TROUBLE_TEXT"] },
  comfort:    { category: "comfort",      vars: ["LEVEL", "POWER_STATE", "OPEN_STATE"] },
  media:      { category: "media",        vars: ["POWER_STATE", "CURRENT_MEDIA_INFO", "CURRENT_VOLUME"] },
};

// -------------------------------------------------------------------------
// Alert thresholds
// -------------------------------------------------------------------------

const ALERT_DOOR_OPEN_MS = 10 * 60 * 1000;       // 10 min
const ALERT_HVAC_RUNNING_MS = 60 * 60 * 1000;     // 60 min
const ALERT_BATTERY_LOW_PCT = 20;
const ALERT_TEMP_RANGE_F = 3;

// -------------------------------------------------------------------------
// Occupancy / home-mode thresholds
// -------------------------------------------------------------------------

const MOTION_RECENT_MS = 15 * 60 * 1000;   // 15 min
const AWAY_INACTIVE_MS = 60 * 60 * 1000;   // 60 min

class StateMachine extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {function} opts.apiFn  – async (apiPath) => JSON  (calls Director via Express proxy)
   * @param {function} [opts.logger]
   */
  constructor({ apiFn, logger }) {
    super();
    this._apiFn = apiFn;
    this._logger = logger || (() => {});

    /** @type {Map<number, object>}  itemId → device state */
    this._devices = new Map();
    /** @type {Map<number, object>}  roomId → room state */
    this._rooms = new Map();

    this._home = {
      mode: "unknown",       // home | away | sleeping | entertaining | unknown
      confidence: "low",
      signals: [],
      occupiedRooms: [],
      lastActivityTime: null,
      lastTransition: null,
      alerts: [],
    };

    this._changeListeners = new Set();

    // Track per-room last-motion timestamps
    this._roomMotion = new Map(); // roomId → timestamp
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /** Discover all device categories and build the device + room maps. */
  async discover() {
    this._devices.clear();
    this._rooms.clear();
    this._roomMotion.clear();

    for (const [typeName, typeInfo] of Object.entries(DEVICE_TYPES)) {
      try {
        const items = await this._apiFn(`api/v1/categories/${typeInfo.category}`);
        if (!Array.isArray(items)) continue;

        const proxyOnlyTypes = ["light", "thermostat"];
        for (const item of items) {
          if (proxyOnlyTypes.includes(typeName) && item.type !== 7) continue; // only proxy (real) devices for lights/thermostats
          if (this._devices.has(item.id)) {
            this._logger("discover-duplicate-skip", { itemId: item.id, keptType: this._devices.get(item.id).type, skippedType: typeName });
            continue;
          }

          this._devices.set(item.id, {
            itemId: item.id,
            name: item.name,
            type: typeName,
            room: item.roomName || "",
            roomId: item.roomParentId || 0,
            floor: item.floorName || "",
            variables: {},
            lastChanged: null,
            lastChangedVariable: null,
            previousValue: null,
            changeCount: 0,
          });

          // Accumulate rooms
          const rid = item.roomParentId;
          if (rid && !this._rooms.has(rid)) {
            this._rooms.set(rid, {
              roomId: rid,
              name: item.roomName || "",
              floor: item.floorName || "",
              devices: [],
            });
          }
          if (rid) {
            const room = this._rooms.get(rid);
            if (!room.devices.includes(item.id)) {
              room.devices.push(item.id);
            }
          }
        }

        this._logger(`discover-${typeName}`, `found ${[...this._devices.values()].filter(d => d.type === typeName).length} devices`);
      } catch (err) {
        // Category may not exist on this Director — that's OK
        this._logger(`discover-${typeName}-skip`, err.message);
      }
    }

    this._logger("discover-complete", {
      devices: this._devices.size,
      rooms: this._rooms.size,
    });
  }

  /** Read initial variable state for every discovered device. */
  async readInitialState() {
    const devices = [...this._devices.values()];
    const BATCH = 10;

    for (let i = 0; i < devices.length; i += BATCH) {
      const batch = devices.slice(i, i + BATCH);
      await Promise.all(batch.map(async (device) => {
        const typeInfo = DEVICE_TYPES[device.type];
        if (!typeInfo || typeInfo.vars.length === 0) return;

        try {
          const vars = await this._apiFn(
            `api/v1/items/${device.itemId}/variables?varnames=${typeInfo.vars.join(",")}`
          );
          if (Array.isArray(vars)) {
            for (const v of vars) {
              device.variables[v.varName] = v.value;
            }
          }
        } catch (err) {
          this._logger("init-state-error", { itemId: device.itemId, error: err.message });
        }
      }));
    }

    // Compute initial derived state
    this._deriveHomeState();
    this._logger("init-state-complete", { devices: devices.length });
  }

  // -----------------------------------------------------------------------
  // WebSocket event handler
  // -----------------------------------------------------------------------

  /** Called for every incoming WebSocket variable-change event. */
  handleDeviceEvent({ itemId, varName, value }) {
    const device = this._devices.get(Number(itemId));
    if (!device) return; // unknown device — ignore

    const oldValue = device.variables[varName];
    // Coerce for comparison (Director sends strings)
    if (String(oldValue) === String(value)) return; // no actual change

    device.previousValue = oldValue;
    device.lastChangedVariable = varName;
    device.variables[varName] = value;
    device.lastChanged = Date.now();
    device.changeCount++;

    // Track motion per room
    if ((varName === "MOTION_STATE" || varName === "MOTION_DETECTED") && this._isTruthy(value)) {
      this._roomMotion.set(device.roomId, Date.now());
    }

    this._home.lastActivityTime = Date.now();

    // Re-derive global state
    this._deriveHomeState();

    // Notify listeners
    const change = {
      itemId: device.itemId,
      varName,
      value,
      oldValue,
      device,
      timestamp: Date.now(),
    };
    this.emit("stateChange", change);
    for (const cb of this._changeListeners) {
      try { cb(change); } catch (err) { this._logger("listener-error", err.message); }
    }
  }

  // -----------------------------------------------------------------------
  // Public query API
  // -----------------------------------------------------------------------

  getDeviceState(itemId) {
    return this._devices.get(Number(itemId)) || null;
  }

  getAllDeviceStates() {
    return this._devices;
  }

  getRoomState(roomId) {
    const room = this._rooms.get(Number(roomId));
    if (!room) return null;

    const devices = room.devices.map(id => this._devices.get(id)).filter(Boolean);
    const occupied = this._isRoomOccupied(Number(roomId), devices);

    return {
      ...room,
      deviceStates: devices,
      occupied: occupied.occupied,
      occupancyConfidence: occupied.confidence,
      lastActivity: occupied.lastActivity,
    };
  }

  getAllRoomStates() {
    return this._rooms;
  }

  getHomeState() {
    return { ...this._home };
  }

  /** Compact, LLM-friendly text summary of the entire home — <500 tokens. */
  getStateSummary() {
    const lines = [];
    const now = Date.now();

    // Home mode line
    const lastAct = this._home.lastActivityTime
      ? this._relativeTime(this._home.lastActivityTime, now)
      : "never";
    const occupiedCount = this._home.occupiedRooms.length;
    const totalRooms = this._rooms.size;
    lines.push(
      `Home: ${this._home.mode.toUpperCase()} mode (${this._home.confidence} confidence). ` +
      `${occupiedCount}/${totalRooms} rooms occupied. Last activity ${lastAct}.`
    );

    // Per-room summaries (only rooms with something noteworthy)
    for (const room of this._rooms.values()) {
      const parts = [];
      const devices = room.devices.map(id => this._devices.get(id)).filter(Boolean);

      // Lights
      const lightsOn = devices.filter(d => d.type === "light" && this._isLightOn(d));
      if (lightsOn.length > 0) {
        const levels = lightsOn.map(d => {
          const lvl = parseInt(d.variables.LIGHT_LEVEL) || 0;
          return `${d.name} ${lvl}%`;
        });
        parts.push(`lights: ${levels.join(", ")}`);
      }

      // Thermostats
      for (const d of devices) {
        if (d.type === "thermostat") {
          const temp = d.variables.TEMPERATURE_F || "?";
          const mode = d.variables.HVAC_MODE || "?";
          const state = d.variables.HVAC_STATE || "";
          parts.push(`${temp}°F ${mode}${state ? ` (${state})` : ""}`);
        }
      }

      // Locks
      for (const d of devices) {
        if (d.type === "lock") {
          parts.push(d.variables.LOCK_STATE || "unknown");
        }
      }

      // Sensors
      for (const d of devices) {
        if (d.type === "sensor") {
          if (d.variables.CONTACT_STATE) parts.push(`door: ${d.variables.CONTACT_STATE}`);
          if (d.variables.MOTION_STATE || d.variables.MOTION_DETECTED) {
            const motionVal = d.variables.MOTION_STATE || d.variables.MOTION_DETECTED;
            parts.push(`motion: ${motionVal}`);
          }
        }
      }

      // Motion recency
      const motionTs = this._roomMotion.get(room.roomId);
      if (motionTs) {
        parts.push(`motion ${this._relativeTime(motionTs, now)}`);
      }

      if (parts.length > 0) {
        const occ = this._home.occupiedRooms.includes(room.roomId) ? "occupied" : "unoccupied";
        lines.push(`  ${room.name}: ${occ} (${parts.join("; ")})`);
      }
    }

    // Alerts
    if (this._home.alerts.length > 0) {
      lines.push(`Alerts: ${this._home.alerts.map(a => a.message).join("; ")}`);
    } else {
      lines.push("Alerts: none.");
    }

    return lines.join("\n");
  }

  /** Subscribe to every state change. */
  onStateChange(cb) {
    this._changeListeners.add(cb);
  }

  /** Unsubscribe from state changes. */
  offStateChange(cb) {
    this._changeListeners.delete(cb);
  }

  // -----------------------------------------------------------------------
  // Derived state engine
  // -----------------------------------------------------------------------

  _deriveHomeState() {
    const now = Date.now();

    // --- Room occupancy ---
    const occupiedRooms = [];
    for (const room of this._rooms.values()) {
      const devices = room.devices.map(id => this._devices.get(id)).filter(Boolean);
      const occ = this._isRoomOccupied(room.roomId, devices);
      if (occ.occupied) occupiedRooms.push(room.roomId);
    }
    this._home.occupiedRooms = occupiedRooms;

    // --- Home mode ---
    const signals = [];
    const lightsOnCount = this._countLightsOn();
    const totalLights = [...this._devices.values()].filter(d => d.type === "light").length;
    const timeSinceActivity = this._home.lastActivityTime
      ? now - this._home.lastActivityTime
      : Infinity;
    const hour = new Date().getHours();
    const isNight = hour >= 23 || hour < 6;

    signals.push(`${lightsOnCount}/${totalLights} lights on`);
    signals.push(`${occupiedRooms.length} rooms occupied`);
    signals.push(`last activity ${this._relativeTime(this._home.lastActivityTime, now)}`);

    let mode = "home";
    let confidence = "medium";

    if (lightsOnCount === 0 && timeSinceActivity > AWAY_INACTIVE_MS && occupiedRooms.length === 0) {
      mode = "away";
      confidence = "high";
      signals.push("no lights, no motion, no activity > 60m");
    } else if (isNight && occupiedRooms.length <= 2 && lightsOnCount <= 2) {
      mode = "sleeping";
      confidence = occupiedRooms.length === 0 ? "high" : "medium";
      signals.push("night time, few lights/rooms");
    } else if (occupiedRooms.length >= 3 && lightsOnCount >= 4) {
      mode = "entertaining";
      confidence = "medium";
      signals.push("3+ rooms occupied, many lights on");
    } else {
      mode = "home";
      confidence = lightsOnCount > 0 ? "high" : "medium";
    }

    const prevMode = this._home.mode;
    this._home.mode = mode;
    this._home.confidence = confidence;
    this._home.signals = signals;

    if (prevMode !== mode && prevMode !== "unknown") {
      this._home.lastTransition = {
        from: prevMode,
        to: mode,
        at: now,
      };
    }

    // --- Alerts ---
    this._home.alerts = this._computeAlerts(now);
  }

  _isRoomOccupied(roomId, devices) {
    const now = Date.now();
    let occupied = false;
    let confidence = "low";
    let lastActivity = null;

    // Check motion
    const motionTs = this._roomMotion.get(roomId);
    if (motionTs && (now - motionTs) < MOTION_RECENT_MS) {
      occupied = true;
      confidence = "high";
      lastActivity = motionTs;
    }

    // Check lights + recent device activity
    const hasLightsOn = devices.some(d => d.type === "light" && this._isLightOn(d));
    const recentDeviceChange = devices.some(d => d.lastChanged && (now - d.lastChanged) < MOTION_RECENT_MS);

    if (hasLightsOn && recentDeviceChange) {
      occupied = true;
      if (confidence === "low") confidence = "medium";
    } else if (hasLightsOn) {
      // Lights on but no recent activity — might just be left on
      if (!occupied) {
        occupied = false;
        confidence = "low";
      }
    }

    // Last activity in room
    for (const d of devices) {
      if (d.lastChanged && (!lastActivity || d.lastChanged > lastActivity)) {
        lastActivity = d.lastChanged;
      }
    }

    return { occupied, confidence, lastActivity };
  }

  _computeAlerts(now) {
    const alerts = [];

    for (const device of this._devices.values()) {
      // Door/window left open > 10 min
      if (device.type === "sensor" && device.variables.CONTACT_STATE) {
        const isOpen = String(device.variables.CONTACT_STATE).toLowerCase().includes("open");
        if (isOpen && device.lastChanged && (now - device.lastChanged) > ALERT_DOOR_OPEN_MS) {
          alerts.push({
            type: "door_open",
            message: `${device.name} open for ${Math.round((now - device.lastChanged) / 60000)}m`,
            deviceId: device.itemId,
            timestamp: now,
          });
        }
      }

      // HVAC running > 60 min continuously
      if (device.type === "thermostat") {
        const hvacState = String(device.variables.HVAC_STATE || "").toLowerCase();
        if (hvacState === "running" && device.lastChanged && (now - device.lastChanged) > ALERT_HVAC_RUNNING_MS) {
          alerts.push({
            type: "hvac_long_run",
            message: `${device.name} HVAC running for ${Math.round((now - device.lastChanged) / 60000)}m`,
            deviceId: device.itemId,
            timestamp: now,
          });
        }

        // Temperature outside range
        const temp = parseFloat(device.variables.TEMPERATURE_F);
        const heat = parseFloat(device.variables.HEAT_SETPOINT_F);
        const cool = parseFloat(device.variables.COOL_SETPOINT_F);
        if (Number.isFinite(temp)) {
          if (Number.isFinite(heat) && temp < heat - ALERT_TEMP_RANGE_F) {
            alerts.push({
              type: "temp_low",
              message: `${device.name} ${temp}°F is ${Math.round(heat - temp)}° below heat setpoint`,
              deviceId: device.itemId,
              timestamp: now,
            });
          }
          if (Number.isFinite(cool) && temp > cool + ALERT_TEMP_RANGE_F) {
            alerts.push({
              type: "temp_high",
              message: `${device.name} ${temp}°F is ${Math.round(temp - cool)}° above cool setpoint`,
              deviceId: device.itemId,
              timestamp: now,
            });
          }
        }
      }

      // Lock battery low
      if (device.type === "lock") {
        const battery = parseFloat(device.variables.BATTERY_LEVEL);
        if (Number.isFinite(battery) && battery < ALERT_BATTERY_LOW_PCT) {
          alerts.push({
            type: "battery_low",
            message: `${device.name} battery at ${battery}%`,
            deviceId: device.itemId,
            timestamp: now,
          });
        }
      }
    }

    return alerts;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  _isLightOn(device) {
    const state = device.variables.LIGHT_STATE;
    const level = parseInt(device.variables.LIGHT_LEVEL);
    return state === "1" || state === 1 || (Number.isFinite(level) && level > 0);
  }

  _isTruthy(value) {
    const s = String(value).toLowerCase();
    return s === "1" || s === "true" || s === "detected" || s === "active";
  }

  _countLightsOn() {
    let count = 0;
    for (const d of this._devices.values()) {
      if (d.type === "light" && this._isLightOn(d)) count++;
    }
    return count;
  }

  _relativeTime(timestamp, now) {
    if (!timestamp) return "never";
    const diff = (now || Date.now()) - timestamp;
    if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    return `${Math.round(diff / 86400000)}d ago`;
  }
}

module.exports = { StateMachine, DEVICE_TYPES };
