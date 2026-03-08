// ---------------------------------------------------------------------------
// MCP Server – Core module (shared by STDIO and HTTP entry points)
// ---------------------------------------------------------------------------

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const { requestText } = require("./http-client");

/**
 * Creates a configured MCP server with all 13 smart-home tools.
 *
 * @param {object} config
 * @param {string} config.baseUrl        – Express server origin, e.g. "http://localhost:3000"
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
    const headers = { "Content-Type": "application/json" };
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
    const params = new URLSearchParams({
      ip: controllerIp,
      token: directorToken,
    });
    const sep = apiPath.includes("?") ? "&" : "?";
    return apiCall(`/api/director/${apiPath}${sep}${params}`);
  }

  function directorPost(apiPath, command, tParams = {}) {
    const params = new URLSearchParams({
      ip: controllerIp,
      token: directorToken,
    });
    const sep = apiPath.includes("?") ? "&" : "?";
    return apiCall(`/api/director/${apiPath}${sep}${params}`, {
      method: "POST",
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
              if (v.varName === "LIGHT_LEVEL") level = parseInt(v.value) || 0;
              if (v.varName === "LIGHT_STATE") on = v.value === "1" || v.value === 1;
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
        } catch {
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
              if (v.varName === "TEMPERATURE_F") info.tempF = parseFloat(v.value);
              if (v.varName === "HEAT_SETPOINT_F") info.heatF = parseFloat(v.value);
              if (v.varName === "COOL_SETPOINT_F") info.coolF = parseFloat(v.value);
              if (v.varName === "HVAC_MODE") info.hvacMode = v.value;
              if (v.varName === "HUMIDITY") info.humidity = parseFloat(v.value);
              if (v.varName === "HVAC_STATE") info.hvacState = v.value;
              if (v.varName === "FAN_MODE") info.fanMode = v.value;
            }
          }
        } catch {}
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
      deviceId: z.number().describe("Light device ID"),
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
      deviceId: z.number().describe("Thermostat device ID"),
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
      deviceId: z.number().describe("Thermostat device ID"),
      temperature: z.number().describe("Heat setpoint in Fahrenheit"),
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
      deviceId: z.number().describe("Thermostat device ID"),
      temperature: z.number().describe("Cool setpoint in Fahrenheit"),
    },
    async ({ deviceId, temperature }) => {
      await directorPost(`api/v1/items/${deviceId}/commands`, "SET_SETPOINT_COOL", { FAHRENHEIT: temperature });
      return { content: [{ type: "text", text: `Thermostat ${deviceId} cool setpoint set to ${temperature}°F` }] };
    }
  );

  server.tool(
    "activate_scene",
    "Activate (trigger) a scene",
    { sceneId: z.number().describe("Scene ID to activate") },
    async ({ sceneId }) => {
      try {
        await directorPost(`api/v1/items/${sceneId}/commands`, "PRESS", {});
      } catch {
        await directorPost(`api/v1/items/${sceneId}/commands`, "ACTIVATE", {});
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
          type: z.enum(["light_level", "light_toggle", "hvac_mode", "heat_setpoint", "cool_setpoint"]).describe("Step type"),
          deviceId: z.number().describe("Device ID"),
          deviceName: z.string().optional().describe("Device name for display"),
          level: z.number().optional().describe("Brightness level (for light_level)"),
          on: z.boolean().optional().describe("On/off (for light_toggle)"),
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

  return server;
}

module.exports = { createMcpServer };
