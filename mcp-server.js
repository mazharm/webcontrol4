// ---------------------------------------------------------------------------
// MCP Server – Core module (shared by STDIO and HTTP entry points)
// ---------------------------------------------------------------------------

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const { requestText } = require("./http-client");


/**
 * Creates a configured MCP server with all 18 smart-home tools.
 *
 * @param {object} config
 * @param {string} config.baseUrl        – Express server origin, e.g. "https://localhost:3443"
 * @param {string} config.controllerIp   – Director IP (or "mock")
 * @param {string} config.directorToken  – Director bearer token
 * @param {string} [config.authHeader]   – Optional auth header ("Bearer xxx" or "Cookie: wc4_session=xxx")
 * @returns {McpServer}
 */
function createMcpServer(config) {
  const { baseUrl, controllerIp, directorToken, authHeader } = config;

  const server = new McpServer({
    name: "WebControl4",
    version: "1.0.0",
  });

  // -------------------------------------------------------------------------
  // HTTP helpers – call the Express API
  // -------------------------------------------------------------------------

  async function apiCall(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...options.headers };
    if (authHeader) {
      if (authHeader.startsWith("Cookie:")) {
        headers["Cookie"] = authHeader.replace("Cookie: ", "");
      } else {
        headers["Authorization"] = authHeader;
      }
    }

    const body = options.body ? JSON.stringify(options.body) : undefined;
    const response = await requestText(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      body,
    });
    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
    }
    try {
      return JSON.parse(response.body);
    } catch {
      return { raw: response.body };
    }
  }

  function directorGet(apiPath) {
    return apiCall(`/api/director/${apiPath}`, {
      headers: {
        "X-Director-IP": controllerIp,
        "X-Director-Token": directorToken,
      },
    });
  }

  function directorPost(apiPath, command, tParams = {}) {
    return apiCall(`/api/director/${apiPath}`, {
      method: "POST",
      headers: {
        "X-Director-IP": controllerIp,
        "X-Director-Token": directorToken,
      },
      body: { async: true, command, tParams },
    });
  }

  // -------------------------------------------------------------------------
  // Read Tools (6)
  // -------------------------------------------------------------------------

  server.tool("list_lights", "List all lights with level, on/off state, room, and floor", {}, async () => {
    const items = await directorGet("api/v1/categories/lights");
    const lights = (Array.isArray(items) ? items : []).filter((i) => i.type === 7);

    // Fetch current levels
    const results = await Promise.all(
      lights.map(async (light) => {
        try {
          const vars = await directorGet(
            `api/v1/items/${light.id}/variables?varnames=LIGHT_LEVEL,LIGHT_STATE`
          );
          let level = 0, on = false;
          if (Array.isArray(vars)) {
            for (const v of vars) {
              if (v.varName === "LIGHT_LEVEL") {
                const parsed = parseInt(v.value, 10);
                level = Number.isNaN(parsed) ? 0 : parsed;
              }
              if (v.varName === "LIGHT_STATE") on = String(v.value) === "1";
            }
          }
          return {
            id: light.id,
            name: light.name,
            room: light.roomName || "",
            floor: light.floorName || "",
            level,
            on,
          };
        } catch (err) {
          console.warn(`Failed to fetch variables for light ${light.id}:`, err.message);
          return { id: light.id, name: light.name, room: light.roomName || "", floor: light.floorName || "", level: 0, on: false };
        }
      })
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.tool("list_thermostats", "List all thermostats with temperature, setpoints, mode, and humidity", {}, async () => {
    const items = await directorGet("api/v1/categories/thermostats");
    const thermos = (Array.isArray(items) ? items : []).filter((i) => i.type === 7);

    const results = await Promise.all(
      thermos.map(async (t) => {
        const info = { id: t.id, name: t.name, room: t.roomName || "", floor: t.floorName || "" };
        try {
          const vars = await directorGet(
            `api/v1/items/${t.id}/variables?varnames=TEMPERATURE_F,HEAT_SETPOINT_F,COOL_SETPOINT_F,HVAC_MODE,HUMIDITY,HVAC_STATE,FAN_MODE`
          );
          if (Array.isArray(vars)) {
            for (const v of vars) {
              if (v.varName === "TEMPERATURE_F") { const n = parseFloat(v.value); if (Number.isFinite(n)) info.tempF = n; }
              if (v.varName === "HEAT_SETPOINT_F") { const n = parseFloat(v.value); if (Number.isFinite(n)) info.heatF = n; }
              if (v.varName === "COOL_SETPOINT_F") { const n = parseFloat(v.value); if (Number.isFinite(n)) info.coolF = n; }
              if (v.varName === "HVAC_MODE") info.hvacMode = v.value;
              if (v.varName === "HUMIDITY") { const n = parseFloat(v.value); if (Number.isFinite(n)) info.humidity = n; }
              if (v.varName === "HVAC_STATE") info.hvacState = v.value;
              if (v.varName === "FAN_MODE") info.fanMode = v.value;
            }
          }
        } catch (err) {
          console.warn(`Failed to fetch variables for thermostat ${t.id}:`, err.message);
        }
        return info;
      })
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.tool("list_scenes", "List all scenes with room and floor", {}, async () => {
    const items = await directorGet("api/v1/categories/voice-scene");
    const scenes = (Array.isArray(items) ? items : []).filter((i) => i.type === 7);
    const results = scenes.map((s) => ({
      id: s.id,
      name: s.name,
      room: s.roomName || "",
      floor: s.floorName || "",
    }));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.tool("list_routines", "List all saved routines with their steps", {}, async () => {
    const routines = await apiCall("/api/routines");
    return { content: [{ type: "text", text: JSON.stringify(routines, null, 2) }] };
  });

  server.tool(
    "get_device_history",
    "Get historical data for a light or thermostat",
    { type: z.enum(["light", "thermo"]).describe("Device type"), id: z.string().describe("Device ID") },
    async ({ type, id }) => {
      const data = await apiCall(`/api/history?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_floor_activity",
    "Get floor-level light activity history",
    { floor: z.string().describe("Floor name") },
    async ({ floor }) => {
      const data = await apiCall(`/api/history?type=floor&id=${encodeURIComponent(floor)}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // -------------------------------------------------------------------------
  // Control Tools (7)
  // -------------------------------------------------------------------------

  server.tool(
    "set_light_level",
    "Set brightness level for a light (0 = off, 100 = full)",
    {
      deviceId: z.number().int().nonnegative().describe("Light device ID"),
      level: z.number().min(0).max(100).describe("Brightness level (0-100)"),
    },
    async ({ deviceId, level }) => {
      await directorPost(`api/v1/items/${deviceId}/commands`, "SET_LEVEL", { LEVEL: level });
      return { content: [{ type: "text", text: `Light ${deviceId} set to ${level}%` }] };
    }
  );

  server.tool(
    "set_thermostat_mode",
    "Set HVAC mode for a thermostat",
    {
      deviceId: z.number().int().nonnegative().describe("Thermostat device ID"),
      mode: z.enum(["Off", "Heat", "Cool", "Auto"]).describe("HVAC mode"),
    },
    async ({ deviceId, mode }) => {
      await directorPost(`api/v1/items/${deviceId}/commands`, "SET_MODE_HVAC", { MODE: mode });
      return { content: [{ type: "text", text: `Thermostat ${deviceId} mode set to ${mode}` }] };
    }
  );

  server.tool(
    "set_heat_setpoint",
    "Set heat setpoint temperature (Fahrenheit)",
    {
      deviceId: z.number().int().nonnegative().describe("Thermostat device ID"),
      temperature: z.number().min(32).max(120).describe("Heat setpoint in Fahrenheit (32-120)"),
    },
    async ({ deviceId, temperature }) => {
      await directorPost(`api/v1/items/${deviceId}/commands`, "SET_SETPOINT_HEAT", { FAHRENHEIT: temperature });
      return { content: [{ type: "text", text: `Thermostat ${deviceId} heat setpoint set to ${temperature}°F` }] };
    }
  );

  server.tool(
    "set_cool_setpoint",
    "Set cool setpoint temperature (Fahrenheit)",
    {
      deviceId: z.number().int().nonnegative().describe("Thermostat device ID"),
      temperature: z.number().min(32).max(120).describe("Cool setpoint in Fahrenheit (32-120)"),
    },
    async ({ deviceId, temperature }) => {
      await directorPost(`api/v1/items/${deviceId}/commands`, "SET_SETPOINT_COOL", { FAHRENHEIT: temperature });
      return { content: [{ type: "text", text: `Thermostat ${deviceId} cool setpoint set to ${temperature}°F` }] };
    }
  );

  server.tool(
    "activate_scene",
    "Activate (trigger) a scene",
    { sceneId: z.number().int().nonnegative().describe("Scene ID to activate") },
    async ({ sceneId }) => {
      try {
        await directorPost(`api/v1/items/${sceneId}/commands`, "PRESS", {});
      } catch {
        try {
          await directorPost(`api/v1/items/${sceneId}/commands`, "ACTIVATE", {});
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to activate scene ${sceneId}: ${err.message}` }], isError: true };
        }
      }
      return { content: [{ type: "text", text: `Scene ${sceneId} activated` }] };
    }
  );

  server.tool(
    "execute_routine",
    "Execute a saved routine by running all its steps in sequence",
    { routineId: z.string().describe("Routine ID to execute") },
    async ({ routineId }) => {
      const routines = await apiCall("/api/routines");
      const routine = (Array.isArray(routines) ? routines : []).find((r) => r.id === routineId);
      if (!routine) {
        return { content: [{ type: "text", text: `Routine ${routineId} not found` }], isError: true };
      }
      if (!routine.steps || routine.steps.length === 0) {
        return { content: [{ type: "text", text: `Routine "${routine.name}" has no steps` }], isError: true };
      }

      const results = [];
      for (const step of routine.steps) {
        try {
          switch (step.type) {
            case "light_level":
              await directorPost(`api/v1/items/${step.deviceId}/commands`, "SET_LEVEL", { LEVEL: step.level });
              results.push(`Set light ${step.deviceId} to ${step.level}%`);
              break;
            case "light_power":
            case "light_toggle": {
              const lvl = step.on ? 100 : 0;
              await directorPost(`api/v1/items/${step.deviceId}/commands`, "SET_LEVEL", { LEVEL: lvl });
              results.push(`Turned ${step.on ? "on" : "off"} light ${step.deviceId}`);
              break;
            }
            case "hvac_mode":
              await directorPost(`api/v1/items/${step.deviceId}/commands`, "SET_MODE_HVAC", { MODE: step.mode });
              results.push(`Set thermostat ${step.deviceId} to ${step.mode}`);
              break;
            case "heat_setpoint":
              await directorPost(`api/v1/items/${step.deviceId}/commands`, "SET_SETPOINT_HEAT", { FAHRENHEIT: step.value });
              results.push(`Set thermostat ${step.deviceId} heat to ${step.value}°F`);
              break;
            case "cool_setpoint":
              await directorPost(`api/v1/items/${step.deviceId}/commands`, "SET_SETPOINT_COOL", { FAHRENHEIT: step.value });
              results.push(`Set thermostat ${step.deviceId} cool to ${step.value}°F`);
              break;
            default:
              results.push(`Unknown step type: ${step.type}`);
          }
        } catch (err) {
          results.push(`Step failed (${step.type}): ${err.message}`);
        }
      }

      return {
        content: [{
          type: "text",
          text: `Executed routine "${routine.name}" (${routine.steps.length} steps):\n${results.join("\n")}`,
        }],
      };
    }
  );

  server.tool(
    "create_routine",
    "Create a new routine with a list of steps and an optional schedule",
    {
      name: z.string().describe("Routine name"),
      steps: z.array(
        z.object({
          type: z.enum(["light_level", "light_power", "light_toggle", "hvac_mode", "heat_setpoint", "cool_setpoint"]).describe("Step type"),
          deviceId: z.number().int().nonnegative().describe("Device ID"),
          deviceName: z.string().optional().describe("Device name for display"),
          level: z.number().optional().describe("Brightness level (for light_level)"),
          on: z.boolean().optional().describe("On/off (for light_power)"),
          mode: z.string().optional().describe("HVAC mode (for hvac_mode)"),
          value: z.number().optional().describe("Temperature value (for setpoints)"),
        })
      ).describe("Array of routine steps"),
      schedule: z.object({
        enabled: z.boolean().describe("Whether the schedule is active"),
        time: z.string().regex(/^\d{2}:\d{2}$/).describe("Time to run in HH:MM format (24-hour)"),
        days: z.array(z.number().min(0).max(6)).describe("Days of week to run (0=Sunday, 6=Saturday)"),
      }).optional().describe("Optional schedule to run the routine automatically"),
    },
    async ({ name, steps, schedule }) => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const routine = { id, name, steps };
      if (schedule) routine.schedule = schedule;
      await apiCall("/api/routines", { method: "POST", body: routine });
      const schedDesc = schedule?.enabled ? ` (scheduled at ${schedule.time})` : "";
      return { content: [{ type: "text", text: `Created routine "${name}" with ${steps.length} steps${schedDesc} (id: ${id})` }] };
    }
  );

  // -------------------------------------------------------------------------
  // Real-Time State & Trending Tools (5)
  // -------------------------------------------------------------------------

  server.tool(
    "get_home_state",
    "Get current home state summary including mode, occupied rooms, and alerts. Returns a compact LLM-friendly text summary.",
    {},
    async () => {
      try {
        const data = await apiCall("/api/state");
        return { content: [{ type: "text", text: data.summary || JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `State not available: ${err.message}. Connect to a controller first.` }], isError: true };
      }
    }
  );

  server.tool(
    "get_device_state",
    "Get current real-time state of a specific device including all tracked variables",
    { itemId: z.number().int().nonnegative().describe("Device item ID") },
    async ({ itemId }) => {
      try {
        const data = await apiCall(`/api/state/${itemId}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Device ${itemId} not found or state not initialized: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_device_trend",
    "Get historical trend data for a device over a time period. Returns raw events.",
    {
      itemId: z.number().int().nonnegative().describe("Device item ID"),
      hours: z.number().optional().describe("Hours of history to retrieve (default 24)"),
    },
    async ({ itemId, hours }) => {
      try {
        const h = hours || 24;
        const data = await apiCall(`/api/trending/${itemId}?hours=${h}`);
        const summary = Array.isArray(data)
          ? `${data.length} events in the last ${h}h. ${data.length > 0 ? `Latest: ${JSON.stringify(data[0])}` : ""}`
          : JSON.stringify(data);
        return { content: [{ type: "text", text: summary }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Trending not available: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_alerts",
    "Get current active alerts (door open, HVAC issues, battery low, temp out of range) and statistical anomalies",
    {},
    async () => {
      try {
        const data = await apiCall("/api/alerts");
        const alerts = data.alerts || [];
        const anomalies = data.anomalies || [];
        let text = `Alerts (${alerts.length}):`;
        if (alerts.length === 0) text += " none";
        for (const a of alerts) text += `\n- [${a.type}] ${a.message}`;
        text += `\n\nAnomalies (${anomalies.length}):`;
        if (anomalies.length === 0) text += " none";
        for (const a of anomalies) text += `\n- Device ${a.itemId} ${a.varName}: today avg ${a.todayAvg} vs baseline ${a.baselineMean} (${a.deviationSigma}σ)`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Alerts not available: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_anomalies",
    "Get statistical anomalies compared to 14-day baseline. Detects unusual device behavior.",
    {
      itemId: z.number().int().nonnegative().optional().describe("Filter to a specific device (omit for all devices)"),
    },
    async ({ itemId }) => {
      try {
        const data = await apiCall("/api/alerts");
        let anomalies = data.anomalies || [];
        if (itemId) anomalies = anomalies.filter(a => a.itemId === itemId);
        if (anomalies.length === 0) {
          return { content: [{ type: "text", text: itemId ? `No anomalies for device ${itemId}` : "No anomalies detected" }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(anomalies, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Anomalies not available: ${err.message}` }], isError: true };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Notification Tool (1)
  // -------------------------------------------------------------------------

  server.tool(
    "send_notification",
    "Send a push notification to the user's phone via Pushover",
    {
      message: z.string().max(1024).describe("Notification body (max 1024 chars)"),
      title: z.string().max(250).optional().describe("Notification title (max 250 chars)"),
      priority: z.number().int().min(-2).max(2).optional().describe("-2=lowest, -1=low, 0=normal, 1=high, 2=emergency"),
      sound: z.string().optional().describe("Sound: siren, spacealarm, incoming, pushover, none"),
      url: z.string().max(512).optional().describe("Supplementary URL"),
      url_title: z.string().max(100).optional().describe("URL display title"),
    },
    async ({ message, title, priority, sound, url, url_title }) => {
      const data = await apiCall("/notify/send", {
        method: "POST",
        body: { message, title, priority, sound, url, urlTitle: url_title },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  // -------------------------------------------------------------------------
  // Ring Tools (9)
  // -------------------------------------------------------------------------

  server.tool("ring_alarm_status", "Get Ring alarm mode and panel status", {}, async () => {
    try {
      const data = await apiCall("/ring/alarm/mode");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Ring alarm not available: ${err.message}` }], isError: true };
    }
  });

  server.tool(
    "ring_alarm_set_mode",
    "Arm/disarm Ring alarm. Modes: away, home, disarm",
    {
      mode: z.enum(["away", "home", "disarm"]).describe("Alarm mode"),
      bypass: z.array(z.string()).optional().describe("Optional device ZIDs to bypass when arming"),
    },
    async ({ mode, bypass }) => {
      const data = await apiCall("/ring/alarm/mode", { method: "POST", body: { mode, bypass } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  server.tool(
    "ring_siren",
    "Control Ring alarm siren (on/off)",
    { action: z.enum(["on", "off"]).describe("Siren action") },
    async ({ action }) => {
      const data = await apiCall("/ring/alarm/siren", { method: "POST", body: { action } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  server.tool("ring_devices", "List all Ring devices (alarm sensors, keypads, range extenders)", {}, async () => {
    const data = await apiCall("/ring/devices");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("ring_sensors", "Get status of Ring sensors (contact, motion, flood/freeze, tilt, glassbreak)", {}, async () => {
    const data = await apiCall("/ring/sensors");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("ring_cameras", "List Ring cameras with status", {}, async () => {
    const data = await apiCall("/ring/cameras");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool(
    "ring_camera_snapshot",
    "Get a snapshot from a Ring camera (returns JPEG image)",
    { camera_id: z.number().describe("Camera ID from ring_cameras") },
    async ({ camera_id }) => {
      try {
        const response = await requestText(`${baseUrl}/ring/cameras/${camera_id}/snapshot`, {
          headers: authHeader ? (authHeader.startsWith("Cookie:")
            ? { Cookie: authHeader.replace("Cookie: ", "") }
            : { Authorization: authHeader }) : {},
        });
        if (response.statusCode >= 400) {
          return { content: [{ type: "text", text: `Snapshot failed: HTTP ${response.statusCode}` }], isError: true };
        }
        return { content: [{ type: "image", data: Buffer.from(response.body, "binary").toString("base64"), mimeType: "image/jpeg" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Snapshot error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "ring_camera_light",
    "Turn Ring camera light on/off",
    {
      camera_id: z.number().describe("Camera ID"),
      on: z.boolean().describe("true = on, false = off"),
    },
    async ({ camera_id, on }) => {
      const data = await apiCall(`/ring/cameras/${camera_id}/light`, { method: "POST", body: { on } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  server.tool(
    "ring_camera_siren",
    "Turn Ring camera siren on/off",
    {
      camera_id: z.number().describe("Camera ID"),
      on: z.boolean().describe("true = on, false = off"),
    },
    async ({ camera_id, on }) => {
      const data = await apiCall(`/ring/cameras/${camera_id}/siren`, { method: "POST", body: { on } });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  // -------------------------------------------------------------------------
  // Govee Leak Tools (3) — only registered if env vars are set
  // -------------------------------------------------------------------------

  // Govee leak tools — proxy through Express API
  server.tool(
    "govee_leak_status",
    "Get current status of all Govee water leak sensors",
    {},
    async () => {
      try {
        const data = await apiCall("/api/govee/leak/status");
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Govee not available: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "govee_leak_poll",
    "Force immediate poll of all Govee leak sensors and return updated state",
    {},
    async () => {
      try {
        const data = await apiCall("/api/govee/leak/poll", { method: "POST" });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Govee poll failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "govee_leak_sensor_detail",
    "Get status for a specific Govee leak sensor by name or device ID",
    { query: z.string().describe("Partial sensor name or exact device ID") },
    async ({ query }) => {
      try {
        const status = await apiCall("/api/govee/leak/status");
        const q = query.toLowerCase();
        const match = (status.sensors || []).find(
          (s) => s.id.toLowerCase() === q || s.name.toLowerCase().includes(q)
        );
        if (!match) {
          const names = (status.sensors || []).map((s) => s.name).join(", ");
          return { content: [{ type: "text", text: `No sensor matching "${query}". Available: ${names || "none"}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(match, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Govee not available: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

module.exports = { createMcpServer };
