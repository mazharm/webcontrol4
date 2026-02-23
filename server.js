require("dotenv").config();

const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const path = require("path");
const dgram = require("dgram");

// ---------------------------------------------------------------------------
// Configuration (from .env or environment)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === "true";
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3443;
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || "";
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || "";
const HTTP_REDIRECT = process.env.HTTP_REDIRECT !== "false"; // default true
const AUTH_USERNAME = process.env.AUTH_USERNAME || "";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";

const app = express();

// ---------------------------------------------------------------------------
// Basic Auth middleware (active only when AUTH_USERNAME + AUTH_PASSWORD are set)
// ---------------------------------------------------------------------------

if (AUTH_USERNAME && AUTH_PASSWORD) {
  const expectedUser = Buffer.from(AUTH_USERNAME);
  const expectedPass = Buffer.from(AUTH_PASSWORD);

  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Basic ")) {
      res.set("WWW-Authenticate", 'Basic realm="WebControl4"');
      return res.status(401).send("Authentication required");
    }
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const sep = decoded.indexOf(":");
    if (sep === -1) {
      res.set("WWW-Authenticate", 'Basic realm="WebControl4"');
      return res.status(401).send("Authentication required");
    }
    const user = Buffer.from(decoded.slice(0, sep));
    const pass = Buffer.from(decoded.slice(sep + 1));

    const userOk =
      user.length === expectedUser.length &&
      crypto.timingSafeEqual(user, expectedUser);
    const passOk =
      pass.length === expectedPass.length &&
      crypto.timingSafeEqual(pass, expectedPass);

    if (userOk && passOk) {
      return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="WebControl4"');
    return res.status(401).send("Invalid credentials");
  });

  console.log("Basic Auth enabled");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Helpers – outbound HTTPS requests to Control4 cloud & local director
// ---------------------------------------------------------------------------

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
    const req = lib.request(
      url,
      {
        method: options.method || "GET",
        headers,
        rejectUnauthorized: false, // director uses self-signed cert
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
// SDDP network discovery
// ---------------------------------------------------------------------------

app.get("/api/discover", (_req, res) => {
  const SDDP_ADDR = "239.255.255.250";
  const SDDP_PORT = 1902;
  const searchMsg =
    'SEARCH * SDDP/1.0\r\nHost: 239.255.255.250:1902\r\nMan: "sddp:discover"\r\nType: sddp:all\r\n\r\n';

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const found = [];

  sock.on("message", (msg, rinfo) => {
    const text = msg.toString();
    const entry = { ip: rinfo.address, port: rinfo.port, raw: text };
    // Parse SDDP headers
    for (const line of text.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        entry[line.slice(0, idx).trim().toLowerCase()] = line
          .slice(idx + 1)
          .trim();
      }
    }
    found.push(entry);
  });

  sock.bind(() => {
    sock.addMembership(SDDP_ADDR);
    sock.send(searchMsg, SDDP_PORT, SDDP_ADDR);
  });

  setTimeout(() => {
    sock.close();
    res.json(found);
  }, 4000);
});

// ---------------------------------------------------------------------------
// Auth: get account bearer token
// ---------------------------------------------------------------------------

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
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

app.get("/api/director/{*path}", async (req, res) => {
  const { ip, token } = req.query;
  if (!ip || !token) {
    return res.status(400).json({ error: "ip and token query params required" });
  }
  const apiPath = "/" + req.params.path;
  try {
    const data = await request(`https://${ip}${apiPath}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Proxy: POST command to Director REST API
// ---------------------------------------------------------------------------

app.post("/api/director/{*path}", async (req, res) => {
  const { ip, token } = req.query;
  if (!ip || !token) {
    return res.status(400).json({ error: "ip and token query params required" });
  }
  const apiPath = "/" + req.params.path;
  try {
    const data = await request(`https://${ip}${apiPath}`, {
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
