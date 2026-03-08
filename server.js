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

// ---------------------------------------------------------------------------
// Data directory (settings + any future persistence)
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
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
// In-memory history storage (server lifetime, ~24 h at 10-s poll interval)
// ---------------------------------------------------------------------------

const MAX_HISTORY_POINTS = 8640; // 24 h × 3600 s / 10 s
const historyStore = {}; // key -> array of timestamped data points

function addHistoryPoint(key, point) {
  if (!historyStore[key]) historyStore[key] = [];
  historyStore[key].push(point);
  if (historyStore[key].length > MAX_HISTORY_POINTS) {
    historyStore[key].shift();
  }
}

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

  // --- Google OAuth login ---
  app.get("/auth/google", (req, res) => {
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers.host;
    const callbackUrl = `${proto}://${host}/auth/google/callback`;
    const state = `web:${req.query.next || "/"}`;
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

      let next = (state || "").replace(/^web:/, "") || "/";
      // Prevent open redirect — only allow relative paths
      if (!/^\/[^\/\\]/.test(next) && next !== "/") next = "/";
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

function isPrivateIp(hostname) {
  // Allow connecting without TLS verification only for private/local IPs
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

function request(url, options = {}, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > 5) {
      return reject(new Error("Too many redirects"));
    }
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const bodyBuf = options.body ? Buffer.from(options.body) : null;
    const headers = { ...options.headers };
    if (bodyBuf) {
      headers["Content-Length"] = bodyBuf.length;
    }
    const timeout = options.timeout || 30000;
    // Only skip TLS verification for private/local IPs (director self-signed certs)
    const skipTlsVerify = isPrivateIp(parsed.hostname);
    const req = lib.request(
      url,
      {
        method: options.method || "GET",
        headers,
        rejectUnauthorized: !skipTlsVerify,
        timeout,
      },
      (res) => {
        // Follow redirects
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          res.resume(); // drain the response
          return resolve(request(redirectUrl, options, _redirectCount + 1));
        }
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          } else {
            resolve(body);
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(new Error("Request timed out")); });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const C4_AUTH_URL = "https://apis.control4.com/authentication/v1/rest";
const C4_CONTROLLER_AUTH_URL =
  "https://apis.control4.com/authentication/v1/rest/authorization";
const C4_ACCOUNTS_URL = "https://apis.control4.com/account/v3/rest/accounts";
const APPLICATION_KEY = "78f6791373d61bea49fdb9fb8897f1f3af193f11";

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
          light.level = parseInt(tParams.LEVEL, 10) || 0;
          light.on = light.level > 0;
        }
        return res.json({ ok: true });
      }

      // Thermostat commands
      const thermo = mockState.thermostats.find(t => t.id === id);
      if (thermo) {
        if (command === "SET_MODE_HVAC") thermo.hvacMode = tParams.MODE || thermo.hvacMode;
        if (command === "SET_SETPOINT_HEAT") thermo.heatF = tParams.FAHRENHEIT != null ? parseFloat(tParams.FAHRENHEIT) : thermo.heatF;
        if (command === "SET_SETPOINT_COOL") thermo.coolF = tParams.FAHRENHEIT != null ? parseFloat(tParams.FAHRENHEIT) : thermo.coolF;
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
      if (item && req.body.name) item.name = req.body.name;
      return res.json({ ok: true });
    }
    const roomMatch = apiPath.match(/^\/api\/v1\/rooms\/(\d+)$/);
    if (roomMatch) {
      const roomId = parseInt(roomMatch[1], 10);
      const newName = req.body.name;
      if (newName) {
        for (const arr of [mockState.lights, mockState.thermostats, mockState.scenes]) {
          for (const item of arr) {
            if (item.roomParentId === roomId) item.roomName = newName;
          }
        }
      }
      return res.json({ ok: true });
    }
  }

  return null; // not handled
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
    const entry = { ip: rinfo.address, port: rinfo.port, raw: text };
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
    res.status(401).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Proxy: GET to Director REST API
// ---------------------------------------------------------------------------

function isValidDirectorIp(ip) {
  if (ip === "mock") return true;
  // Only allow valid IPv4 addresses to prevent SSRF
  const parts = ip.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

app.get("/api/director/{*path}", async (req, res) => {
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
    res.status(502).json({ error: err.message });
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
    res.status(502).json({ error: err.message });
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
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// History: record a state snapshot from the frontend
// ---------------------------------------------------------------------------

app.post("/api/history/record", (req, res) => {
  const { lights = [], thermostats = [], floors = {} } = req.body;
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

  for (const [floorKey, onCount] of Object.entries(floors)) {
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
  if (anthropicKey !== undefined) appSettings.anthropicKey = String(anthropicKey);
  if (anthropicModel)             appSettings.anthropicModel = String(anthropicModel);
  persistSettings();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routines: CRUD endpoints
// ---------------------------------------------------------------------------

app.get("/api/routines", (_req, res) => {
  res.json(routinesStore);
});

app.post("/api/routines", (req, res) => {
  const routine = req.body;
  if (!routine || !routine.id) {
    return res.status(400).json({ error: "routine with id required" });
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
        res.redirect(301, `https://${host}:${HTTPS_PORT}${req.url}`);
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
