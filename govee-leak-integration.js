// ---------------------------------------------------------------------------
// Govee Leak Sensor — Integration wiring (REST routes + MCP tools)
// ---------------------------------------------------------------------------

const GoveeLeak = require("./govee-leak");

let activeGoveeInstance = null;

function safeLog(log, level, message, ...args) {
  try {
    (log[level] || log.info || console.log).call(log, message, ...args);
  } catch {
    // Logging must never break sensor polling.
  }
}

function safeBroadcast(broadcast, log, eventType, data) {
  try {
    broadcast(eventType, data);
  } catch (err) {
    safeLog(log, "error", `[govee] Broadcast failed: ${err?.message || String(err)}`);
  }
}

/**
 * Initialize Govee leak sensor polling with a pre-authenticated token.
 *
 * @param {object} app          – Express app
 * @param {function} broadcast  – broadcastSSE(eventType, data) from server.js
 * @param {object} config       – { goveeEmail, goveeToken, goveeTokenTimestamp, goveePollInterval, log, onTokenExpired }
 * @returns {GoveeLeak}
 */
function initGoveeLeak(app, broadcast, config) {
  const log = config.log || console;

  if (activeGoveeInstance) {
    activeGoveeInstance.stop().catch((err) =>
      safeLog(log, "error", `[govee] Failed to stop previous poller: ${err?.message || String(err)}`)
    );
    activeGoveeInstance = null;
  }

  const govee = new GoveeLeak({
    email: config.goveeEmail,
    token: config.goveeToken,
    tokenTimestamp: config.goveeTokenTimestamp,
    pollInterval: config.goveePollInterval,
    log,
    onDevicesReady(sensors) {
      safeLog(log, "info", `[govee] ${sensors.length} leak sensor(s) ready`);
      safeBroadcast(broadcast, log, "govee:status", { connected: true, sensorCount: sensors.length });
    },
    onTokenExpired() {
      safeLog(log, "warn", "[govee] Token expired — user must re-authenticate via Settings");
      safeBroadcast(broadcast, log, "govee:status", { connected: false, needsReauth: true });
      if (config.onTokenExpired) {
        try { config.onTokenExpired(); } catch (err) {
          safeLog(log, "error", `[govee] onTokenExpired handler failed: ${err?.message || String(err)}`);
        }
      }
    },
    onLeakEvent(event) {
      // Broadcast to SSE clients
      safeBroadcast(broadcast, log, "govee:leak", event);

      if (event.leakDetected) {
        safeLog(log, "warn", `[govee] 🚨 LEAK DETECTED: ${event.name} (${event.device})`);
      } else {
        safeLog(log, "info", `[govee] ✅ Clear: ${event.name} (${event.device})`);
      }

      // Future: state machine integration
      // stateMachine.handleEvent('leak_detected', event);

      // Future: Control4 water valve shutoff
      // if (event.leakDetected) {
      //   await c4Client.executeCommand(WATER_VALVE_PROXY_ID, 'CLOSE');
      // }

      // Future: SQLite trending / event logging
      // trending.logEvent('govee_leak', event);
    },
  });

  // Start polling (async, non-blocking — errors logged internally)
  activeGoveeInstance = govee;
  govee.start().catch((err) => safeLog(log, "error", "[govee] Start failed:", err.message));

  return govee;
}

/**
 * Register Govee REST routes on the Express app.
 * These are registered once and use `getGoveeInstance` to access the current instance.
 *
 * @param {object} app                  – Express app
 * @param {function} getGoveeInstance   – Returns current GoveeLeak instance (or null)
 */
function registerGoveeRoutes(app, getGoveeInstance) {
  app.get("/api/govee/leak/status", (_req, res) => {
    const govee = getGoveeInstance();
    if (!govee) return res.json({ sensorCount: 0, anyLeak: false, needsReauth: false, sensors: [] });
    res.json(govee.getState());
  });

  app.get("/api/govee/leak/sensors", (_req, res) => {
    const govee = getGoveeInstance();
    if (!govee) return res.json([]);
    res.json(govee.getState().sensors);
  });

  app.post("/api/govee/leak/poll", async (_req, res) => {
    const govee = getGoveeInstance();
    if (!govee) return res.status(503).json({ error: "Govee not configured" });
    try {
      await govee.pollLeakStatus();
      res.json(govee.getState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

/**
 * Returns MCP tool definitions for the Govee leak integration.
 *
 * @param {GoveeLeak} govee – Initialized GoveeLeak instance
 * @returns {Array<{name, description, inputSchema, handler}>}
 */
function getGoveeLeakMCPTools(govee) {
  return [
    {
      name: "govee_leak_status",
      description: "Get current status of all Govee water leak sensors",
      inputSchema: {},
      handler: async () => govee.getState(),
    },
    {
      name: "govee_leak_poll",
      description: "Force immediate poll of all Govee leak sensors and return updated state",
      inputSchema: {},
      handler: async () => {
        await govee.pollLeakStatus();
        return govee.getState();
      },
    },
    {
      name: "govee_leak_sensor_detail",
      description: "Get status for a specific Govee leak sensor by name or device ID",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Partial sensor name or exact device ID to search for",
          },
        },
        required: ["query"],
      },
      handler: async ({ query }) => {
        if (typeof query !== "string" || !query.trim()) {
          return { error: "query must be a non-empty string" };
        }
        const state = govee.getState();
        const q = query.toLowerCase();
        const match = state.sensors.find(
          (s) =>
            String(s.id).toLowerCase() === q ||
            String(s.name).toLowerCase().includes(q)
        );
        if (!match) {
          const names = state.sensors.map((s) => s.name).join(", ");
          return { error: `No sensor matching "${query}". Available: ${names || "none"}` };
        }
        return match;
      },
    },
  ];
}

module.exports = { GoveeLeak, initGoveeLeak, registerGoveeRoutes, getGoveeLeakMCPTools };
