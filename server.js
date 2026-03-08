require("dotenv").config();

const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const path = require("path");
const dgram = require("dgram");
const oauth = require("./oauth");
const { isPrivateOrLocalHost, requestText } = require("./http-client");
const { C4WebSocket } = require("./c4-websocket");
const { StateMachine } = require("./state-machine");
const { TrendingEngine } = require("./trending");

// ---------------------------------------------------------------------------
// Data directory (settings + any future persistence)
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (err) {
    console.error("Failed to create data directory:", err.message);
  }
}

// ---------------------------------------------------------------------------
// App settings (persisted to data/settings.json)
// ---------------------------------------------------------------------------

let appSettings = {
  anthropicKey: "",
  anthropicModel: "claude-haiku-4-5-20251001",
};

try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    appSettings = { ...appSettings, ...stored };
  }
} catch (err) {
  console.error("Failed to load settings:", err.message);
}

function persistSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
  } catch (err) {
    console.error("Failed to save settings:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Routines persistence (data/routines.json)
// ---------------------------------------------------------------------------

const ROUTINES_FILE = path.join(DATA_DIR, "routines.json");
let routinesStore = [];

try {
  if (fs.existsSync(ROUTINES_FILE)) {
    routinesStore = JSON.parse(fs.readFileSync(ROUTINES_FILE, "utf8"));
  }
} catch (err) {
  console.error("Failed to load routines:", err.message);
}

function persistRoutines() {
  try {
    fs.writeFileSync(ROUTINES_FILE, JSON.stringify(routinesStore, null, 2));
  } catch (err) {
    console.error("Failed to save routines:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Routine scheduler — runs routines at configured times
// ---------------------------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let lastScheduleCheck = "";  // "YYYY-MM-DD HH:MM" to avoid double-firing

function startScheduler() {
  const schedulerInterval = setInterval(() => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
    if (minuteKey === lastScheduleCheck) return;
    lastScheduleCheck = minuteKey;

    const currentDay = now.getDay(); // 0=Sunday
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    for (const routine of routinesStore) {
      const sched = routine.schedule;
      if (!sched || !sched.enabled) continue;
      if (sched.time !== currentTime) continue;
      if (Array.isArray(sched.days) && sched.days.length > 0 && !sched.days.includes(currentDay)) continue;

      console.log(`[Scheduler] Running routine "${routine.name}" (${currentTime} ${DAY_NAMES[currentDay]})`);
      executeRoutineSteps(routine).catch((err) => {
        console.error(`[Scheduler] Routine "${routine.name}" failed:`, err.message);
      });
    }
  }, 15_000); // check every 15 seconds for responsive scheduling
  schedulerInterval.unref();
}

async function executeRoutineSteps(routine) {
  if (!routine.steps || routine.steps.length === 0) return;

  for (const step of routine.steps) {
    try {
      switch (step.type) {
        case "light_level":
          await executeScheduledCommand(step.deviceId, "SET_LEVEL", { LEVEL: step.level });
          break;
        case "light_toggle":
          await executeScheduledCommand(step.deviceId, "SET_LEVEL", { LEVEL: step.on ? 100 : 0 });
          break;
        case "hvac_mode":
          await executeScheduledCommand(step.deviceId, "SET_MODE_HVAC", { MODE: step.mode });
          break;
        case "heat_setpoint":
          await executeScheduledCommand(step.deviceId, "SET_SETPOINT_HEAT", { FAHRENHEIT: step.value });
          break;
        case "cool_setpoint":
          await executeScheduledCommand(step.deviceId, "SET_SETPOINT_COOL", { FAHRENHEIT: step.value });
          break;
      }
    } catch (err) {
      console.error(`[Scheduler] Step failed (${step.type} device ${step.deviceId}):`, err.message);
    }
  }
}

// Execute a command against the mock controller or a real director.
// Uses the last-known connection info from the most recent web session.
let schedulerDirectorInfo = { ip: null, token: null };

function setSchedulerDirectorInfo(ip, token) {
  if (ip && token) {
    schedulerDirectorInfo = { ip, token };
  }
}

async function executeScheduledCommand(deviceId, command, tParams) {
  const { ip, token } = schedulerDirectorInfo;

  // Mock mode — execute directly against in-memory mock state
  if (ip === "mock") {
    const mockReq = { method: "POST", body: { command, tParams }, query: {} };
    const mockRes = {
      json: () => {},
      status: () => ({ json: () => {} }),
    };
    handleMockRequest(mockReq, mockRes, `/api/v1/items/${deviceId}/commands`);
    return;
  }

  if (!ip || !token) {
    throw new Error("No director connection — connect from the web UI first");
  }

  const fullUrl = `https://${ip}/api/v1/items/${deviceId}/commands`;
  await request(fullUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ async: true, command, tParams }),
  });
}

// ---------------------------------------------------------------------------
// In-memory history storage (server lifetime, ~24 h at 10-s poll interval)
// ---------------------------------------------------------------------------

const MAX_HISTORY_POINTS = 8640; // 24 h × 3600 s / 10 s
const historyStore = Object.create(null); // key -> array of timestamped data points

function addHistoryPoint(key, point) {
  if (!historyStore[key]) historyStore[key] = [];
  historyStore[key].push(point);
  if (historyStore[key].length > MAX_HISTORY_POINTS) {
    historyStore[key].shift();
  }
}

// ---------------------------------------------------------------------------
// Real-time engine singletons (WebSocket + state machine + trending)
// ---------------------------------------------------------------------------

let c4ws = null;              // C4WebSocket instance
let stateMachine = null;      // StateMachine instance
let trending = null;          // TrendingEngine instance
let sseClients = [];          // Active Server-Sent Events clients
let fallbackPollTimer = null; // Fallback polling when WS is down
let mockEventTimer = null;    // Mock mode event simulator

// ---------------------------------------------------------------------------
// Anthropic model list
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS = [
  { id: "claude-haiku-4-5-20251001",    name: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-6",            name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6",              name: "Claude Opus 4.6" },
];

// ---------------------------------------------------------------------------
// Configuration (from .env or environment)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === "true";
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3443;
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || "";
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || "";
const HTTP_REDIRECT = process.env.HTTP_REDIRECT !== "false"; // default true

const app = express();

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com"
  );
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Authentication – Google OAuth (when GOOGLE_CLIENT_ID is configured)
// ---------------------------------------------------------------------------

// Auth status endpoint – always available so the frontend can check
app.get("/auth/status", (req, res) => {
  if (!oauth.isConfigured()) {
    return res.json({ authenticated: true, provider: null });
  }
  const session = oauth.getSessionFromReq(req);
  res.json({
    authenticated: !!session,
    email: session?.email || null,
    name: session?.name || null,
    provider: "google",
  });
});

if (oauth.isConfigured()) {
  console.log("Google OAuth enabled");

  function sanitizeNextPath(next) {
    const value = String(next || "/");
    if (!value.startsWith("/")) return "/";
    if (value.startsWith("//") || value.includes("\\")) return "/";
    if (/%2f|%5c/i.test(value)) return "/";
    if (value.includes("?") || value.includes("#")) return "/";
    return value;
  }

  // --- Google OAuth login ---
  app.get("/auth/google", (req, res) => {
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers.host;
    const callbackUrl = `${proto}://${host}/auth/google/callback`;
    const state = `web:${sanitizeNextPath(req.query.next)}`;
    res.redirect(oauth.googleAuthUrl(callbackUrl, state));
  });

  // --- Google OAuth callback ---
  app.get("/auth/google/callback", async (req, res) => {
    try {
      const { code, state } = req.query;
      if (!code) return res.status(400).send("Missing authorization code");

      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers.host;
      const callbackUrl = `${proto}://${host}/auth/google/callback`;

      const tokens = await oauth.googleExchangeCode(code, callbackUrl);
      const user = await oauth.googleUserInfo(tokens.access_token);

      if (!oauth.isEmailAllowed(user.email)) {
        return res.status(403).send("Email not authorized. Check ALLOWED_EMAILS.");
      }

      const sessionId = oauth.createSession(user.email, user.name || user.email);
      const isSecure = proto === "https";
      oauth.setSessionCookie(res, sessionId, isSecure);

      const next = sanitizeNextPath((state || "").replace(/^web:/, "") || "/");
      res.redirect(next);
    } catch (err) {
      console.error("Google OAuth callback error:", err);
      res.status(500).send("Authentication failed. Please try again.");
    }
  });

  // --- Logout ---
  app.get("/auth/logout", (req, res) => {
    const sid = oauth.getSessionIdFromReq(req);
    if (sid) oauth.deleteSession(sid);
    oauth.clearSessionCookie(res);
    res.redirect("/");
  });

  // --- Protect /api/* routes (session cookie or bearer token) ---
  app.use("/api", (req, res, next) => {
    if (oauth.getSessionFromReq(req)) return next();
    if (oauth.getTokenFromReq(req)) return next();
    res.status(401).json({ error: "Authentication required" });
  });
}

// ---------------------------------------------------------------------------
// Helpers – outbound HTTPS requests to Control4 cloud & local director
// ---------------------------------------------------------------------------

function request(url, options = {}, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > 5) {
      return reject(new Error("Too many redirects"));
    }
    requestText(url, options, _redirectCount)
      .then(({ statusCode, body }) => {
        if (statusCode >= 400) {
          reject(new Error(`HTTP ${statusCode}: ${body}`));
        } else {
          resolve(body);
        }
      })
      .catch(reject);
  });
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

const C4_AUTH_URL = "https://apis.control4.com/authentication/v1/rest";
const C4_CONTROLLER_AUTH_URL =
  "https://apis.control4.com/authentication/v1/rest/authorization";
const C4_ACCOUNTS_URL = "https://apis.control4.com/account/v3/rest/accounts";
const APPLICATION_KEY = process.env.C4_APPLICATION_KEY || "78f6791373d61bea49fdb9fb8897f1f3af193f11";

// ---------------------------------------------------------------------------
// Mock controller state (for demo mode when ip=mock)
// ---------------------------------------------------------------------------

const mockState = {
  lights: [
    // Main Floor - Kitchen
    { id: 100, name: "Kitchen Ceiling",    type: 7, roomName: "Kitchen",      roomParentId: 10, floorName: "Main", level: 80, on: true },
    { id: 101, name: "Kitchen Island",     type: 7, roomName: "Kitchen",      roomParentId: 10, floorName: "Main", level: 0,  on: false },
    { id: 102, name: "Kitchen Sink Light", type: 7, roomName: "Kitchen",      roomParentId: 10, floorName: "Main", level: 0,  on: false },
    // Main Floor - Dining
    { id: 110, name: "Dining Chandelier",  type: 7, roomName: "Dining Room",  roomParentId: 11, floorName: "Main", level: 0,  on: false },
    { id: 111, name: "Dining Sconces",     type: 7, roomName: "Dining Room",  roomParentId: 11, floorName: "Main", level: 0,  on: false },
    // Main Floor - Living Room
    { id: 120, name: "Living Room Ceiling",type: 7, roomName: "Living Room",  roomParentId: 12, floorName: "Main", level: 60, on: true },
    { id: 121, name: "Living Room Lamp",   type: 7, roomName: "Living Room",  roomParentId: 12, floorName: "Main", level: 0,  on: false },
    // Main Floor - Hallway
    { id: 130, name: "Hallway Light",      type: 7, roomName: "Hallway",      roomParentId: 13, floorName: "Main", level: 0,  on: false },
    // Upper Floor
    { id: 200, name: "Master Ceiling",     type: 7, roomName: "Master Bedroom", roomParentId: 20, floorName: "Upstairs", level: 0,  on: false },
    { id: 201, name: "Master Nightstand",  type: 7, roomName: "Master Bedroom", roomParentId: 20, floorName: "Upstairs", level: 0,  on: false },
    { id: 210, name: "Kids Room Light",    type: 7, roomName: "Kids Room",    roomParentId: 21, floorName: "Upstairs", level: 0,  on: false },
    { id: 220, name: "Bathroom Vanity",    type: 7, roomName: "Bathroom",     roomParentId: 22, floorName: "Upstairs", level: 0,  on: false },
    { id: 230, name: "Office Desk Light",  type: 7, roomName: "Office",       roomParentId: 23, floorName: "Upstairs", level: 100, on: true },
    // Lower Floor
    { id: 300, name: "Basement Ceiling",   type: 7, roomName: "Basement",     roomParentId: 30, floorName: "Lower Level", level: 0,  on: false },
    { id: 301, name: "Basement Bar",       type: 7, roomName: "Basement",     roomParentId: 30, floorName: "Lower Level", level: 0,  on: false },
    { id: 310, name: "Laundry Light",      type: 7, roomName: "Laundry",      roomParentId: 31, floorName: "Lower Level", level: 0,  on: false },
    // Exterior
    { id: 400, name: "Front Porch Light",  type: 7, roomName: "Exterior",     roomParentId: 40, floorName: "Main", level: 0,  on: false },
    { id: 401, name: "Garage Light",       type: 7, roomName: "Exterior",     roomParentId: 40, floorName: "Main", level: 0,  on: false },
    { id: 402, name: "Back Deck Light",    type: 7, roomName: "Exterior",     roomParentId: 40, floorName: "Main", level: 0,  on: false },
  ],
  thermostats: [
    { id: 500, name: "Main Floor Thermostat",  type: 7, roomName: "Hallway",        roomParentId: 13, floorName: "Main",     tempF: 72, heatF: 68, coolF: 74, hvacMode: "Auto", humidity: 45 },
    { id: 501, name: "Upper Floor Thermostat", type: 7, roomName: "Master Bedroom",  roomParentId: 20, floorName: "Upstairs", tempF: 70, heatF: 66, coolF: 73, hvacMode: "Heat", humidity: 40 },
  ],
  scenes: [
    // Whole House
    { id: 600, name: "Good Morning", type: 7, roomName: "",             roomParentId: null, floorName: "" },
    { id: 601, name: "Good Night",   type: 7, roomName: "",             roomParentId: null, floorName: "" },
    { id: 602, name: "Away",         type: 7, roomName: "",             roomParentId: null, floorName: "" },
    { id: 603, name: "Movie Time",   type: 7, roomName: "",             roomParentId: null, floorName: "" },
    // Main Floor
    { id: 610, name: "Dinner Party", type: 7, roomName: "Dining Room",  roomParentId: 11, floorName: "Main" },
    { id: 611, name: "Cooking Mode", type: 7, roomName: "Kitchen",      roomParentId: 10, floorName: "Main" },
    // Upper Floor
    { id: 620, name: "Bedtime",      type: 7, roomName: "Master Bedroom", roomParentId: 20, floorName: "Upstairs" },
  ],
};

function handleMockRequest(req, res, apiPath) {
  // GET categories
  if (req.method === "GET") {
    if (apiPath.match(/^\/api\/v1\/categories\/lights$/)) {
      return res.json(mockState.lights);
    }
    if (apiPath.match(/^\/api\/v1\/categories\/thermostats$/)) {
      return res.json(mockState.thermostats);
    }
    if (apiPath.match(/^\/api\/v1\/categories\/(voice-scene|scenes|experience)$/)) {
      return res.json(mockState.scenes);
    }
    // Additional categories for state-machine discovery (return empty for mock)
    if (apiPath.match(/^\/api\/v1\/categories\/(locks|sensors|security|comfort|media)$/)) {
      return res.json([]);
    }

    // GET variables for an item
    const varMatch = apiPath.match(/^\/api\/v1\/items\/(\d+)\/variables$/);
    if (varMatch) {
      const id = parseInt(varMatch[1], 10);
      const varnames = (req.query.varnames || "").split(",").filter(Boolean);

      // Check lights
      const light = mockState.lights.find(l => l.id === id);
      if (light) {
        const vars = [];
        for (const v of varnames) {
          if (v === "LIGHT_LEVEL") vars.push({ varName: "LIGHT_LEVEL", value: String(light.level) });
          if (v === "LIGHT_STATE") vars.push({ varName: "LIGHT_STATE", value: light.on ? "1" : "0" });
        }
        return res.json(vars);
      }

      // Check thermostats
      const thermo = mockState.thermostats.find(t => t.id === id);
      if (thermo) {
        const vars = [];
        for (const v of varnames) {
          if (v === "TEMPERATURE_F" && thermo.tempF != null) vars.push({ varName: "TEMPERATURE_F", value: String(thermo.tempF) });
          if (v === "HEAT_SETPOINT_F" && thermo.heatF != null) vars.push({ varName: "HEAT_SETPOINT_F", value: String(thermo.heatF) });
          if (v === "COOL_SETPOINT_F" && thermo.coolF != null) vars.push({ varName: "COOL_SETPOINT_F", value: String(thermo.coolF) });
          if (v === "HVAC_MODE" && thermo.hvacMode != null) vars.push({ varName: "HVAC_MODE", value: thermo.hvacMode });
          if (v === "HUMIDITY" && thermo.humidity != null) vars.push({ varName: "HUMIDITY", value: String(thermo.humidity) });
          if (v === "HVAC_STATE") vars.push({ varName: "HVAC_STATE", value: thermo.hvacMode === "Off" ? "Off" : "Running" });
          if (v === "FAN_MODE") vars.push({ varName: "FAN_MODE", value: "Auto" });
        }
        return res.json(vars);
      }

      return res.json([]);
    }
  }

  // POST commands
  if (req.method === "POST") {
    const cmdMatch = apiPath.match(/^\/api\/v1\/items\/(\d+)\/commands$/);
    if (cmdMatch) {
      const id = parseInt(cmdMatch[1], 10);
      const { command, tParams } = req.body;

      // Light commands
      const light = mockState.lights.find(l => l.id === id);
      if (light) {
        if (command === "SET_LEVEL") {
          light.level = clampNumber(tParams?.LEVEL, 0, 100, 0);
          light.on = light.level > 0;
          // Push through state machine so SSE/trending/derived state update
          emitMockDeviceEvents(id, [
            { varName: "LIGHT_LEVEL", value: String(light.level) },
            { varName: "LIGHT_STATE", value: light.on ? "1" : "0" },
          ]);
        }
        return res.json({ ok: true });
      }

      // Thermostat commands
      const thermo = mockState.thermostats.find(t => t.id === id);
      if (thermo) {
        const events = [];
        if (command === "SET_MODE_HVAC") {
          const allowedModes = ["Off", "Heat", "Cool", "Auto"];
          if (allowedModes.includes(tParams.MODE)) {
            thermo.hvacMode = tParams.MODE;
            events.push({ varName: "HVAC_MODE", value: thermo.hvacMode });
            // HVAC_STATE follows mode
            const hvacState = thermo.hvacMode === "Off" ? "Off" : "Running";
            events.push({ varName: "HVAC_STATE", value: hvacState });
          }
        }
        if (command === "SET_SETPOINT_HEAT") {
          thermo.heatF = clampNumber(tParams?.FAHRENHEIT, 32, 120, thermo.heatF);
          events.push({ varName: "HEAT_SETPOINT_F", value: String(thermo.heatF) });
        }
        if (command === "SET_SETPOINT_COOL") {
          thermo.coolF = clampNumber(tParams?.FAHRENHEIT, 32, 120, thermo.coolF);
          events.push({ varName: "COOL_SETPOINT_F", value: String(thermo.coolF) });
        }
        emitMockDeviceEvents(id, events);
        return res.json({ ok: true });
      }

      // Scene commands (PRESS / ACTIVATE)
      const scene = mockState.scenes.find(s => s.id === id);
      if (scene) {
        return res.json({ ok: true });
      }

      return res.status(404).json({ error: "Item not found" });
    }
  }

  // PUT update item/room name
  if (req.method === "PUT") {
    const itemMatch = apiPath.match(/^\/api\/v1\/items\/(\d+)$/);
    if (itemMatch) {
      const id = parseInt(itemMatch[1], 10);
      const item = [...mockState.lights, ...mockState.thermostats, ...mockState.scenes].find(i => i.id === id);
      if (item && req.body.name) {
        const name = String(req.body.name).slice(0, 200);
        item.name = name;
      }
      return res.json({ ok: true });
    }
    const roomMatch = apiPath.match(/^\/api\/v1\/rooms\/(\d+)$/);
    if (roomMatch) {
      const roomId = parseInt(roomMatch[1], 10);
      const newName = req.body.name;
      if (newName && typeof newName === "string") {
        const safeName = newName.slice(0, 200);
        for (const arr of [mockState.lights, mockState.thermostats, mockState.scenes]) {
          for (const item of arr) {
            if (item.roomParentId === roomId) item.roomName = safeName;
          }
        }
      }
      return res.json({ ok: true });
    }
  }

  return null; // not handled
}

/**
 * Push variable-change events from mock commands into the state machine,
 * exactly like the real Director would push WebSocket events after a command.
 */
function emitMockDeviceEvents(itemId, events) {
  if (!stateMachine) return;
  for (const { varName, value } of events) {
    try {
      stateMachine.handleDeviceEvent({ itemId, varName, value });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// SDDP network discovery
// ---------------------------------------------------------------------------

app.get("/api/discover", (_req, res) => {
  const SDDP_ADDR = "239.255.255.250";
  const SDDP_PORT = 1902;
  const searchMsg =
    'SEARCH * SDDP/1.0\r\nHost: 239.255.255.250:1902\r\nMan: "sddp:discover"\r\nType: sddp:all\r\n\r\n';

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const found = [];
  let responded = false;

  function finish() {
    if (responded) return;
    responded = true;
    try { sock.close(); } catch {}
    res.json(found);
  }

  sock.on("error", (err) => {
    console.error("SDDP socket error:", err.message);
    finish();
  });

  sock.on("message", (msg, rinfo) => {
    const text = msg.toString();
    const entry = Object.create(null);
    entry.ip = rinfo.address;
    entry.port = rinfo.port;
    entry.raw = text;
    // Parse SDDP headers
    for (const line of text.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim().toLowerCase();
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        entry[key] = line
          .slice(idx + 1)
          .trim();
      }
    }
    found.push(entry);
  });

  sock.bind(() => {
    try {
      sock.addMembership(SDDP_ADDR);
    } catch (err) {
      console.error("SDDP addMembership error:", err.message);
    }
    sock.send(Buffer.from(searchMsg), SDDP_PORT, SDDP_ADDR, (err) => {
      if (err) console.error("SDDP send error:", err.message);
    });
  });

  setTimeout(finish, 4000);
});

// ---------------------------------------------------------------------------
// Auth: get account bearer token
// ---------------------------------------------------------------------------

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  // Demo mode
  if (username === "demo@demo.com") {
    return res.json({ accountToken: "mock-token" });
  }
  try {
    const body = JSON.stringify({
      clientInfo: {
        device: {
          deviceName: "WebControl4",
          deviceUUID: "0000000000000001",
          make: "WebControl4",
          model: "WebControl4",
          os: "Android",
          osVersion: "10",
        },
        userInfo: {
          applicationKey: APPLICATION_KEY,
          password,
          userName: username,
        },
      },
    });
    const data = await request(C4_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const json = JSON.parse(data);
    const token = json?.authToken?.token;
    if (!token) throw new Error("No token in response");
    res.json({ accountToken: token });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(401).json({ error: "Authentication failed" });
  }
});

// ---------------------------------------------------------------------------
// Auth: list controllers on account
// ---------------------------------------------------------------------------

app.post("/api/auth/controllers", async (req, res) => {
  const { accountToken } = req.body;
  if (!accountToken) {
    return res.status(400).json({ error: "accountToken required" });
  }
  // Demo mode
  if (accountToken === "mock-token") {
    return res.json([{ name: "Test Controller", controllerCommonName: "mock-controller", localIP: "mock" }]);
  }
  try {
    const data = await request(C4_ACCOUNTS_URL, {
      headers: { Authorization: `Bearer ${accountToken}` },
    });
    const json = JSON.parse(data);
    res.json(json.account || json);
  } catch (err) {
    console.error("Controller list error:", err.message);
    res.status(500).json({ error: "Failed to fetch controllers" });
  }
});

// ---------------------------------------------------------------------------
// Auth: get director bearer token for a specific controller
// ---------------------------------------------------------------------------

app.post("/api/auth/director-token", async (req, res) => {
  const { accountToken, controllerCommonName } = req.body;
  if (!accountToken || !controllerCommonName) {
    return res
      .status(400)
      .json({ error: "accountToken and controllerCommonName required" });
  }
  // Demo mode
  if (controllerCommonName === "mock-controller") {
    return res.json({ directorToken: "mock-director-token", validSeconds: 999999 });
  }
  try {
    const body = JSON.stringify({
      serviceInfo: {
        commonName: controllerCommonName,
        services: "director",
      },
    });
    const data = await request(C4_CONTROLLER_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accountToken}`,
      },
      body,
    });
    const json = JSON.parse(data);
    const token = json?.authToken?.token;
    const validSeconds = json?.authToken?.validSeconds;
    if (!token) throw new Error("No director token in response");
    res.json({ directorToken: token, validSeconds });
  } catch (err) {
    console.error("Director token error:", err.message);
    res.status(500).json({ error: "Failed to get director token" });
  }
});

// ---------------------------------------------------------------------------
// Proxy: GET to Director REST API
// ---------------------------------------------------------------------------

function isValidDirectorIp(ip) {
  if (ip === "mock") return true;
  // Only allow local/private controller IPs to prevent SSRF to arbitrary hosts
  return isPrivateOrLocalHost(ip);
}

app.get("/api/director/{*path}", async (req, res) => {
  const { ip, token, ...rest } = req.query;
  if (!ip || !token) {
    return res.status(400).json({ error: "ip and token query params required" });
  }
  if (!isValidDirectorIp(ip)) {
    return res.status(400).json({ error: "invalid ip address format" });
  }
  setSchedulerDirectorInfo(ip, token);
  const apiPath = "/" + req.params.path.join("/");
  if (ip === "mock") {
    const handled = handleMockRequest(req, res, apiPath);
    if (handled !== null) return;
    return res.json([]);
  }
  const qs = new URLSearchParams(rest).toString();
  const fullUrl = `https://${ip}${apiPath}${qs ? "?" + qs : ""}`;
  try {
    const data = await request(fullUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    try {
      res.json(JSON.parse(data));
    } catch {
      res.json({ ok: true, raw: data });
    }
  } catch (err) {
    console.error("Director GET proxy error:", err.message);
    res.status(502).json({ error: "Director request failed" });
  }
});

// ---------------------------------------------------------------------------
// Proxy: POST command to Director REST API
// ---------------------------------------------------------------------------

app.post("/api/director/{*path}", async (req, res) => {
  const { ip, token, ...rest } = req.query;
  if (!ip || !token) {
    return res.status(400).json({ error: "ip and token query params required" });
  }
  if (!isValidDirectorIp(ip)) {
    return res.status(400).json({ error: "invalid ip address format" });
  }
  const apiPath = "/" + req.params.path.join("/");
  if (ip === "mock") {
    const handled = handleMockRequest(req, res, apiPath);
    if (handled !== null) return;
    return res.json({ ok: true });
  }
  const qs = new URLSearchParams(rest).toString();
  const fullUrl = `https://${ip}${apiPath}${qs ? "?" + qs : ""}`;
  try {
    const data = await request(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(req.body),
    });
    // Some commands return empty body
    try {
      res.json(JSON.parse(data));
    } catch {
      res.json({ ok: true, raw: data });
    }
  } catch (err) {
    console.error("Director POST proxy error:", err.message);
    res.status(502).json({ error: "Director request failed" });
  }
});

// ---------------------------------------------------------------------------
// Proxy: PUT to Director REST API
// ---------------------------------------------------------------------------

app.put("/api/director/{*path}", async (req, res) => {
  const { ip, token, ...rest } = req.query;
  if (!ip || !token) {
    return res.status(400).json({ error: "ip and token query params required" });
  }
  if (!isValidDirectorIp(ip)) {
    return res.status(400).json({ error: "invalid ip address format" });
  }
  const apiPath = "/" + req.params.path.join("/");
  if (ip === "mock") {
    const handled = handleMockRequest(req, res, apiPath);
    if (handled !== null) return;
    return res.json({ ok: true });
  }
  const qs = new URLSearchParams(rest).toString();
  const fullUrl = `https://${ip}${apiPath}${qs ? "?" + qs : ""}`;
  try {
    const data = await request(fullUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(req.body),
    });
    try {
      res.json(JSON.parse(data));
    } catch {
      res.json({ ok: true, raw: data });
    }
  } catch (err) {
    console.error("Director PUT proxy error:", err.message);
    res.status(502).json({ error: "Director request failed" });
  }
});

// ---------------------------------------------------------------------------
// History: record a state snapshot from the frontend
// ---------------------------------------------------------------------------

const HISTORY_RECORD_MAX_ITEMS  = 500;
const HISTORY_RECORD_MAX_FLOORS = 50;

app.post("/api/history/record", (req, res) => {
  const { lights = [], thermostats = [], floors = {} } = req.body;
  if (!Array.isArray(lights) || !Array.isArray(thermostats) ||
      typeof floors !== "object" || floors === null || Array.isArray(floors)) {
    return res.status(400).json({ error: "invalid payload" });
  }
  if (lights.length > HISTORY_RECORD_MAX_ITEMS || thermostats.length > HISTORY_RECORD_MAX_ITEMS) {
    return res.status(400).json({ error: "too many items" });
  }
  const ts = Date.now();

  for (const l of lights) {
    if (l.id != null) {
      addHistoryPoint(`light:${l.id}`, {
        ts,
        on: !!l.on,
        level: Number(l.level) || 0,
      });
    }
  }

  for (const t of thermostats) {
    if (t.id != null) {
      addHistoryPoint(`thermo:${t.id}`, {
        ts,
        tempF: t.tempF != null ? Number(t.tempF) : null,
        heatF: t.heatF != null ? Number(t.heatF) : null,
        coolF: t.coolF != null ? Number(t.coolF) : null,
        hvacMode: t.hvacMode || null,
      });
    }
  }

  let floorCount = 0;
  for (const [floorKey, onCount] of Object.entries(floors)) {
    if (floorCount >= HISTORY_RECORD_MAX_FLOORS) break;
    // Reject keys that could cause prototype pollution or key collisions;
    // sanitize to keep only safe characters
    if (
      typeof floorKey === "string" &&
      floorKey !== "__proto__" &&
      floorKey !== "constructor" &&
      floorKey !== "prototype"
    ) {
      const safeKey = floorKey.replace(/[^a-zA-Z0-9 _\-]/g, "").slice(0, 128);
      if (safeKey) {
        addHistoryPoint(`floor:${safeKey}`, { ts, onCount: Number(onCount) || 0 });
        floorCount++;
      }
    }
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// History: query stored data points
// ---------------------------------------------------------------------------

app.get("/api/history", (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) {
    return res.status(400).json({ error: "type and id query params required" });
  }
  // Validate type against allowlist
  const allowedTypes = ["light", "thermo", "floor"];
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: "type must be one of: light, thermo, floor" });
  }
  // Sanitize id: only allow alphanumeric chars, spaces, hyphens, underscores
  const safeId = String(id).replace(/[^a-zA-Z0-9 _\-]/g, "").slice(0, 128);
  if (!safeId) {
    return res.status(400).json({ error: "invalid id" });
  }
  const key = `${type}:${safeId}`;
  res.json(historyStore[key] || []);
});

// ---------------------------------------------------------------------------
// Settings: read (key is masked) / write
// ---------------------------------------------------------------------------

app.get("/api/settings", (_req, res) => {
  res.json({
    anthropicModel: appSettings.anthropicModel,
    hasAnthropicKey: !!appSettings.anthropicKey,
  });
});

app.post("/api/settings", (req, res) => {
  const { anthropicKey, anthropicModel } = req.body;
  if (anthropicKey !== undefined) {
    const keyStr = String(anthropicKey).trim();
    if (keyStr && keyStr.length > 256) {
      return res.status(400).json({ error: "anthropicKey is too long" });
    }
    appSettings.anthropicKey = keyStr;
  }
  if (anthropicModel) {
    const validModel = ANTHROPIC_MODELS.find((m) => m.id === String(anthropicModel));
    if (!validModel) {
      return res.status(400).json({ error: "invalid anthropicModel" });
    }
    appSettings.anthropicModel = validModel.id;
  }
  persistSettings();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routines: CRUD endpoints
// ---------------------------------------------------------------------------

app.get("/api/routines", (_req, res) => {
  res.json(routinesStore);
});

const ROUTINE_NAME_MAX_LEN = 200;
const ROUTINE_STEPS_MAX    = 100;

app.post("/api/routines", (req, res) => {
  const routine = req.body;
  if (!routine || !routine.id) {
    return res.status(400).json({ error: "routine with id required" });
  }
  if (!routine.name || typeof routine.name !== "string" || !routine.name.trim()) {
    return res.status(400).json({ error: "routine name required" });
  }
  if (routine.name.length > ROUTINE_NAME_MAX_LEN) {
    return res.status(400).json({ error: `routine name must be at most ${ROUTINE_NAME_MAX_LEN} characters` });
  }
  if (!Array.isArray(routine.steps)) {
    return res.status(400).json({ error: "routine steps must be an array" });
  }
  if (routine.steps.length > ROUTINE_STEPS_MAX) {
    return res.status(400).json({ error: `routine may have at most ${ROUTINE_STEPS_MAX} steps` });
  }
  // Validate individual step structure
  const validStepTypes = ["light_level", "light_toggle", "hvac_mode", "heat_setpoint", "cool_setpoint"];
  for (const step of routine.steps) {
    if (!step || typeof step !== "object") {
      return res.status(400).json({ error: "each step must be an object" });
    }
    if (!validStepTypes.includes(step.type)) {
      return res.status(400).json({ error: "invalid step type" });
    }
    if (typeof step.deviceId !== "number" || !Number.isFinite(step.deviceId)) {
      return res.status(400).json({ error: "each step must have a numeric deviceId" });
    }
    if (step.type === "light_level" && (typeof step.level !== "number" || step.level < 0 || step.level > 100)) {
      return res.status(400).json({ error: "light_level step requires level 0-100" });
    }
    if (step.type === "light_toggle" && typeof step.on !== "boolean") {
      return res.status(400).json({ error: "light_toggle step requires boolean 'on'" });
    }
    if (step.type === "hvac_mode" && !["Off", "Heat", "Cool", "Auto"].includes(step.mode)) {
      return res.status(400).json({ error: "hvac_mode step requires mode: Off, Heat, Cool, or Auto" });
    }
    if ((step.type === "heat_setpoint" || step.type === "cool_setpoint") &&
        (typeof step.value !== "number" || step.value < 32 || step.value > 120)) {
      return res.status(400).json({ error: "setpoint step requires value between 32 and 120" });
    }
  }
  // Validate optional schedule
  if (routine.schedule) {
    const s = routine.schedule;
    if (typeof s.enabled !== "boolean") s.enabled = false;
    if (typeof s.time !== "string" || !/^\d{2}:\d{2}$/.test(s.time)) {
      return res.status(400).json({ error: "schedule.time must be HH:MM format" });
    }
    if (!Array.isArray(s.days) || s.days.some((d) => typeof d !== "number" || d < 0 || d > 6)) {
      return res.status(400).json({ error: "schedule.days must be array of 0-6 (Sun-Sat)" });
    }
  }
  const idx = routinesStore.findIndex((r) => r.id === routine.id);
  if (idx !== -1) {
    routinesStore[idx] = routine;
  } else {
    routinesStore.push(routine);
  }
  persistRoutines();
  res.json({ ok: true });
});

app.delete("/api/routines/:id", (req, res) => {
  const { id } = req.params;
  routinesStore = routinesStore.filter((r) => r.id !== id);
  persistRoutines();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// LLM: list available models
// ---------------------------------------------------------------------------

app.get("/api/llm/models", (_req, res) => {
  res.json(ANTHROPIC_MODELS);
});

// ---------------------------------------------------------------------------
// LLM: chat / control via Anthropic
// ---------------------------------------------------------------------------

function buildSystemPrompt(context, mode) {
  const devices  = context?.devices  || [];
  const routines = context?.routines || [];
  const historySummary = context?.historySummary || "";

  let prompt;

  if (mode === "analyze") {
    prompt =
      "You are a smart home analytics assistant. " +
      "Analyze the historical data provided and give specific, actionable recommendations " +
      "for automations, routines, and energy savings. " +
      "Reference actual device names and observed patterns.";
  } else {
    prompt =
      "You are a smart home control assistant for a Control4 system. " +
      "The user gives you natural language commands to control their home.\n\n" +
      "ALWAYS respond with a JSON object and nothing else. The JSON must have:\n" +
      '- "message": A friendly natural language confirmation of what you are doing\n' +
      '- "actions": An array of device commands to execute (can be empty)\n\n' +
      "Action types:\n" +
      '- { "type": "light_level",    "deviceId": <number>, "level": <0-100> }\n' +
      '- { "type": "light_toggle",   "deviceId": <number>, "on": <boolean> }\n' +
      '- { "type": "hvac_mode",      "deviceId": <number>, "mode": "Off"|"Heat"|"Cool"|"Auto" }\n' +
      '- { "type": "heat_setpoint",  "deviceId": <number>, "value": <temp_in_F> }\n' +
      '- { "type": "cool_setpoint",  "deviceId": <number>, "value": <temp_in_F> }\n' +
      '- { "type": "run_routine",    "routineId": "<id>" }\n' +
      '- { "type": "create_routine", "name": "<name>", "steps": [<step objects as above>] }\n\n' +
      "For modify_routine requests, use create_routine with the same name to replace it.";
  }

  if (devices.length > 0) {
    prompt += "\n\nAvailable devices:";
    for (const d of devices) {
      if (d.type === "light") {
        prompt += `\n- Light "${d.name}" (id:${d.id}, floor:"${d.floor}", room:"${d.room}", ${d.on ? `ON at ${d.level}%` : "OFF"})`;
      } else if (d.type === "thermostat") {
        prompt += `\n- Thermostat "${d.name}" (id:${d.id}, floor:"${d.floor}", temp:${d.tempF ?? "?"}°F, heat:${d.heatF ?? "?"}°F, cool:${d.coolF ?? "?"}°F, mode:${d.hvacMode ?? "?"})`;
      }
    }
  }

  if (routines.length > 0) {
    prompt += "\n\nAvailable routines:";
    for (const r of routines) {
      prompt += `\n- "${r.name}" (id:"${r.id}")`;
    }
  }

  if (historySummary) {
    prompt += `\n\nHistorical data:\n${historySummary}`;
  }

  return prompt;
}

app.post("/api/llm/chat", async (req, res) => {
  if (!appSettings.anthropicKey) {
    return res.status(400).json({
      error: "Anthropic API key not configured. Go to Settings to add your key.",
    });
  }

  const { message, context, mode } = req.body;
  if (!message) {
    return res.status(400).json({ error: "message required" });
  }

  const systemPrompt = buildSystemPrompt(context, mode);

  try {
    const bodyStr = JSON.stringify({
      model: appSettings.anthropicModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: String(message) }],
    });

    const responseStr = await request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": appSettings.anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: bodyStr,
    });

    const response = JSON.parse(responseStr);
    const text = response?.content?.[0]?.text || "";

    if (mode === "analyze") {
      return res.json({ message: text, actions: [] });
    }

    // Try to parse as JSON (model may wrap in markdown code fences)
    let parsed = { message: text, actions: [] };
    try {
      const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : text.trim();
      const j = JSON.parse(jsonStr);
      if (j && j.message) parsed = j;
    } catch {
      // Not valid JSON — treat raw text as the message
    }

    res.json(parsed);
  } catch (err) {
    // Try to surface a user-friendly error from the Anthropic error body
    let errMsg = err.message;
    try {
      const bodyPart = err.message.replace(/^HTTP \d+: /, "");
      const json = JSON.parse(bodyPart);
      if (json?.error?.message) errMsg = json.error.message;
    } catch {}
    res.status(500).json({ error: errMsg });
  }
});

// ---------------------------------------------------------------------------
// Real-time: initialise WebSocket + state machine + trending
// ---------------------------------------------------------------------------

async function initializeRealtime({ controllerIp, directorToken, accountToken, controllerCommonName }) {
  // 1. Trending engine (idempotent — keep existing if already running)
  if (!trending) {
    trending = new TrendingEngine({
      dbPath: path.join(DATA_DIR, "trending.db"),
      logger: (...args) => console.log("[trending]", ...args),
    });
    trending.init();
  }

  // 2. State machine — always re-create on new connection
  stateMachine = new StateMachine({
    apiFn: async (apiPath) => {
      const params = new URLSearchParams({ ip: controllerIp, token: directorToken });
      const sep = apiPath.includes("?") ? "&" : "?";
      const url = `http://localhost:${PORT}/api/director/${apiPath}${sep}${params}`;
      const resp = await requestText(url);
      if (resp.statusCode >= 400) throw new Error(`HTTP ${resp.statusCode}: ${resp.body}`);
      return JSON.parse(resp.body);
    },
    logger: (...args) => console.log("[state]", ...args),
  });

  await stateMachine.discover();
  await stateMachine.readInitialState();

  // 3. Wire state changes → trending + SSE
  let prevMode = null;
  stateMachine.on("stateChange", (change) => {
    trending.recordEvent({
      itemId: change.itemId,
      varName: change.varName,
      value: change.value,
      oldValue: change.oldValue,
      timestamp: change.timestamp,
    });

    // Track home-mode transitions
    const homeState = stateMachine.getHomeState();
    if (homeState.mode !== prevMode) {
      trending.recordModeChange(homeState.mode, homeState.confidence);
      prevMode = homeState.mode;
    }

    broadcastSSE("stateChange", change);
  });

  // 4. WebSocket (skip for mock)
  if (controllerIp !== "mock") {
    // Clean up previous connection
    if (c4ws) {
      c4ws.disconnect();
      c4ws = null;
    }
    stopFallbackPolling();

    const refreshTokenFn = async () => {
      const body = JSON.stringify({
        serviceInfo: { commonName: controllerCommonName, services: "director" },
      });
      const data = await request(C4_CONTROLLER_AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountToken}` },
        body,
      });
      const json = JSON.parse(data);
      return { token: json.authToken.token, validSeconds: json.authToken.validSeconds };
    };

    c4ws = new C4WebSocket({
      directorIp: controllerIp,
      directorToken,
      refreshTokenFn,
      logger: (...args) => console.log("[ws]", ...args),
    });

    c4ws.onAnyChange((payload) => {
      stateMachine.handleDeviceEvent(payload);
    });

    c4ws.on("disconnected", () => startFallbackPolling(controllerIp, directorToken));
    c4ws.on("reconnected", async () => {
      stopFallbackPolling();
      try { await stateMachine.readInitialState(); } catch {}
    });
    c4ws.on("reconnectFailed", () => startFallbackPolling(controllerIp, directorToken));

    // Connect with retry
    try {
      await connectWithRetry(c4ws);
    } catch {
      console.log("[ws] Initial connection failed, using fallback polling");
      startFallbackPolling(controllerIp, directorToken);
    }
  } else {
    // Mock mode: simulate periodic events
    startMockEventEmitter();
  }

  console.log(`[realtime] Initialized (${controllerIp === "mock" ? "mock" : "websocket"} mode, ${stateMachine.getAllDeviceStates().size} devices)`);
}

async function connectWithRetry(wsInstance, maxAttempts = 5) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      await wsInstance.connect();
      return;
    } catch (err) {
      attempt++;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      console.log(`[ws] Connection attempt ${attempt} failed, retrying in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Failed after ${maxAttempts} attempts`);
}

function startFallbackPolling(controllerIp, directorToken) {
  if (fallbackPollTimer) return;
  if (!stateMachine) return;
  console.log("[resilience] Starting fallback polling (15s interval)");

  fallbackPollTimer = setInterval(async () => {
    try {
      await stateMachine.readInitialState();
    } catch (err) {
      console.error("[resilience] Fallback poll error:", err.message);
    }
  }, 15000);
  if (fallbackPollTimer.unref) fallbackPollTimer.unref();
}

function stopFallbackPolling() {
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
    console.log("[resilience] Stopped fallback polling");
  }
}

function startMockEventEmitter() {
  if (mockEventTimer) clearInterval(mockEventTimer);

  mockEventTimer = setInterval(() => {
    if (!stateMachine) return;
    const devices = [...stateMachine.getAllDeviceStates().values()].filter(d => d.type === "light");
    if (devices.length === 0) return;

    const device = devices[Math.floor(Math.random() * devices.length)];
    const newLevel = Math.random() > 0.3 ? Math.floor(Math.random() * 100) : 0;

    stateMachine.handleDeviceEvent({ itemId: device.itemId, varName: "LIGHT_LEVEL", value: String(newLevel) });
    stateMachine.handleDeviceEvent({ itemId: device.itemId, varName: "LIGHT_STATE", value: newLevel > 0 ? "1" : "0" });
  }, 30000);
  if (mockEventTimer.unref) mockEventTimer.unref();
}

function broadcastSSE(eventType, data) {
  const payload = JSON.stringify({
    type: eventType,
    itemId: data.itemId,
    varName: data.varName,
    value: data.value,
    oldValue: data.oldValue,
    timestamp: data.timestamp,
  });
  for (const client of sseClients) {
    try { client.write(`data: ${payload}\n\n`); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Real-time: POST /api/realtime/connect
// ---------------------------------------------------------------------------

app.post("/api/realtime/connect", async (req, res) => {
  const { controllerIp, directorToken, accountToken, controllerCommonName } = req.body;
  if (!controllerIp || !directorToken) {
    return res.status(400).json({ error: "controllerIp and directorToken required" });
  }
  if (controllerIp !== "mock" && !isValidDirectorIp(controllerIp)) {
    return res.status(400).json({ error: "invalid controller IP" });
  }
  try {
    await initializeRealtime({ controllerIp, directorToken, accountToken, controllerCommonName });
    res.json({
      ok: true,
      mode: controllerIp === "mock" ? "mock" : "websocket",
      devices: stateMachine ? stateMachine.getAllDeviceStates().size : 0,
      rooms: stateMachine ? stateMachine.getAllRoomStates().size : 0,
    });
  } catch (err) {
    console.error("[realtime] Init error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Real-time: SSE endpoint for browser
// ---------------------------------------------------------------------------

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send initial state
  if (stateMachine) {
    const init = JSON.stringify({ type: "init", summary: stateMachine.getStateSummary() });
    res.write(`data: ${init}\n\n`);
  }

  sseClients.push(res);

  req.on("close", () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// ---------------------------------------------------------------------------
// Real-time: state & trending REST endpoints
// ---------------------------------------------------------------------------

app.get("/api/state", (_req, res) => {
  if (!stateMachine) return res.status(503).json({ error: "State not initialized" });
  res.json({
    home: stateMachine.getHomeState(),
    summary: stateMachine.getStateSummary(),
    deviceCount: stateMachine.getAllDeviceStates().size,
    roomCount: stateMachine.getAllRoomStates().size,
  });
});

// NB: /api/state/room/:roomId must come before /api/state/:itemId
// to avoid "room" being parsed as an itemId
app.get("/api/state/room/:roomId", (req, res) => {
  if (!stateMachine) return res.status(503).json({ error: "State not initialized" });
  const roomId = parseInt(req.params.roomId, 10);
  if (!Number.isFinite(roomId)) return res.status(400).json({ error: "invalid roomId" });
  const room = stateMachine.getRoomState(roomId);
  if (!room) return res.status(404).json({ error: "room not found" });
  res.json(room);
});

app.get("/api/state/:itemId", (req, res) => {
  if (!stateMachine) return res.status(503).json({ error: "State not initialized" });
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isFinite(itemId)) return res.status(400).json({ error: "invalid itemId" });
  const device = stateMachine.getDeviceState(itemId);
  if (!device) return res.status(404).json({ error: "device not found" });
  res.json(device);
});

app.get("/api/trending/:itemId", (req, res) => {
  if (!trending) return res.status(503).json({ error: "Trending not initialized" });
  const itemId = parseInt(req.params.itemId, 10);
  const hours = parseInt(req.query.hours, 10) || 24;
  if (!Number.isFinite(itemId)) return res.status(400).json({ error: "invalid itemId" });
  res.json(trending.getDeviceHistory(itemId, hours));
});

app.get("/api/trending/:itemId/daily", (req, res) => {
  if (!trending) return res.status(503).json({ error: "Trending not initialized" });
  const itemId = parseInt(req.params.itemId, 10);
  const days = parseInt(req.query.days, 10) || 7;
  if (!Number.isFinite(itemId)) return res.status(400).json({ error: "invalid itemId" });
  res.json(trending.getDailySummary(itemId, days));
});

app.get("/api/alerts", (_req, res) => {
  if (!stateMachine || !trending) return res.status(503).json({ error: "Not initialized" });
  const alerts = stateMachine.getHomeState().alerts || [];
  const anomalies = trending.getAnomalies(24);
  res.json({ alerts, anomalies });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  const health = {
    status: "ok",
    uptime: Math.round(process.uptime()),
    timestamp: Date.now(),
    websocket: {
      connected: c4ws ? c4ws.isConnected() : false,
      mode: c4ws ? "websocket" : (stateMachine ? (fallbackPollTimer ? "polling" : "mock") : "disconnected"),
    },
    stateMachine: {
      initialized: !!stateMachine,
      deviceCount: stateMachine ? stateMachine.getAllDeviceStates().size : 0,
      roomCount: stateMachine ? stateMachine.getAllRoomStates().size : 0,
    },
    trending: {
      initialized: !!trending,
      ...(trending ? trending.getStats() : {}),
    },
    sseClients: sseClients.length,
  };

  if (!stateMachine || (!c4ws?.isConnected() && !fallbackPollTimer && !mockEventTimer)) {
    health.status = "degraded";
  }

  res.json(health);
});

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------

app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------------------------------------------------------------------
// Self-signed certificate helper
// ---------------------------------------------------------------------------

function ensureSelfSignedCert() {
  const certDir = path.join(__dirname, "certs");
  const certPath = path.join(certDir, "selfsigned.crt");
  const keyPath = path.join(certDir, "selfsigned.key");

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: certPath, key: keyPath };
  }

  try {
    if (!fs.existsSync(certDir)) {
      fs.mkdirSync(certDir, { recursive: true });
    }
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes ` +
        `-keyout "${keyPath}" -out "${certPath}" ` +
        `-days 365 -subj "/CN=WebControl4"`,
      { stdio: "pipe" }
    );
    console.log("Generated self-signed certificate in certs/");
    return { cert: certPath, key: keyPath };
  } catch {
    console.error(
      "Failed to generate self-signed cert (is openssl installed?). Falling back to HTTP."
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

function startServer() {
  if (HTTPS_ENABLED) {
    let certPath = TLS_CERT_FILE;
    let keyPath = TLS_KEY_FILE;

    // Use provided certs or generate self-signed
    if (!certPath || !keyPath) {
      const generated = ensureSelfSignedCert();
      if (!generated) {
        // Fallback to plain HTTP
        app.listen(PORT, () => {
          console.log(`WebControl4 running at http://localhost:${PORT} (HTTPS failed, using HTTP)`);
        });
        return;
      }
      certPath = generated.cert;
      keyPath = generated.key;
    }

    const tlsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };

    https.createServer(tlsOptions, app).listen(HTTPS_PORT, () => {
      console.log(`WebControl4 running at https://localhost:${HTTPS_PORT}`);
    });

    // Optional HTTP -> HTTPS redirect
    if (HTTP_REDIRECT) {
      const redirectApp = express();
      redirectApp.use((req, res) => {
        const host = (req.headers.host || "").replace(/:\d+$/, "");
        // Validate the path to prevent open-redirect attacks
        let safePath = req.url;
        if (!safePath.startsWith("/") || safePath.startsWith("//")) {
          safePath = "/";
        }
        res.redirect(301, `https://${host}:${HTTPS_PORT}${safePath}`);
      });
      redirectApp.listen(PORT, () => {
        console.log(`HTTP :${PORT} redirecting to HTTPS :${HTTPS_PORT}`);
      });
    }
  } else {
    // Plain HTTP (original behavior)
    app.listen(PORT, () => {
      console.log(`WebControl4 running at http://localhost:${PORT}`);
    });
  }
}

startServer();
startScheduler();
