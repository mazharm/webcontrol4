#!/usr/bin/env node
// ---------------------------------------------------------------------------
// MCP Server – Streamable HTTP transport (for ChatGPT / Claude.ai)
// ---------------------------------------------------------------------------
// Runs its own Express server on port 3001. The main Express server must
// also be running (default https://localhost:3443).
//
// Usage:   node mcp-http.js
// Env:     MCP_HTTP_PORT      (default: 3001)
//          MCP_CONTROLLER_IP  (default: "mock")
//          MCP_DIRECTOR_TOKEN (auto-auths in demo/mock mode if empty)
//          MCP_BASE_URL       (default: "https://localhost:3443")
//          GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (for OAuth)

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpServer } = require("./mcp-server.js");
const { requestJson } = require("./http-client");
const oauth = require("./oauth");
const {
  hasBasicAuthConfigured,
  getBasicAuthHeader,
  isLoopbackRequest,
  isValidBasicAuthHeader,
  sendBasicAuthChallenge,
} = require("./auth-utils");

const MCP_PORT = parseInt(process.env.MCP_HTTP_PORT, 10) || 3001;
const APP_PORT = process.env.HTTPS_ENABLED === "true"
  ? (process.env.HTTPS_PORT || 3443)
  : (process.env.PORT || process.env.HTTPS_PORT || 3443);
const BASE_URL = process.env.MCP_BASE_URL || (
  process.env.HTTPS_ENABLED === "true"
    ? `https://localhost:${APP_PORT}`
    : `http://localhost:${APP_PORT}`
);
const CONTROLLER_IP = process.env.MCP_CONTROLLER_IP || "mock";
const PKCE_S256_RE = /^[A-Za-z0-9\-_]{43,128}$/;
const GOOGLE_OAUTH_ENABLED = oauth.isConfigured();
const BASIC_AUTH_ENABLED = hasBasicAuthConfigured();
const MCP_IDEMPOTENCY_TTL_MS = 2 * 60 * 1000;
const MCP_IDEMPOTENCY_PENDING_TTL_MS = 30 * 1000;
const MCP_IDEMPOTENCY_MAX_ENTRIES = 200;
const MCP_IDEMPOTENCY_MAX_BODY_BYTES = 512 * 1024;
const MCP_IDEMPOTENCY_MAX_KEY_LENGTH = 256;
const mcpIdempotencyCache = new Map();
let mcpIdempotencyBytes = 0;

function deleteMcpCacheEntry(key) {
  const entry = mcpIdempotencyCache.get(key);
  if (!entry) return false;
  if (entry.status === "complete" && entry.bodyLength) {
    mcpIdempotencyBytes = Math.max(0, mcpIdempotencyBytes - entry.bodyLength);
  }
  mcpIdempotencyCache.delete(key);
  return true;
}

function cleanupMcpIdempotencyCache() {
  const now = Date.now();
  for (const [key, entry] of mcpIdempotencyCache) {
    if (entry.expiresAt <= now) {
      deleteMcpCacheEntry(key);
    }
  }

  while (mcpIdempotencyBytes > MCP_IDEMPOTENCY_MAX_BODY_BYTES) {
    if (!evictOldestMcpEntry((entry) => entry.status === "complete")) break;
  }
}

function evictOldestMcpEntry(predicate) {
  for (const [key, entry] of mcpIdempotencyCache) {
    if (!predicate || predicate(entry, key)) {
      return deleteMcpCacheEntry(key);
    }
  }
  return false;
}

setInterval(cleanupMcpIdempotencyCache, 30_000).unref();

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function getMcpPrincipal(req) {
  if (req.mcpUser?.clientId) return `oauth:${req.mcpUser.clientId}`;
  if (typeof req.headers.authorization === "string" && req.headers.authorization) {
    return `auth:${hashValue(req.headers.authorization)}`;
  }
  return `loopback:${req.ip || req.socket?.remoteAddress || "unknown"}`;
}

function getMcpRequestHash(req) {
  try {
    return hashValue(JSON.stringify(req.body ?? null));
  } catch {
    return null;
  }
}

function getMcpIdempotencyKey(req) {
  const clientKey = getMcpPrincipal(req);
  const headerKey = typeof req.headers["idempotency-key"] === "string"
    ? req.headers["idempotency-key"].trim()
    : "";
  if (headerKey) {
    if (headerKey.length > MCP_IDEMPOTENCY_MAX_KEY_LENGTH) return null;
    return `header:${clientKey}:${hashValue(headerKey)}`;
  }

  try {
    if (req.body && !Array.isArray(req.body) && req.body.id !== undefined) {
      const method = String(req.body.method || "");
      const id = String(req.body.id);
      if (method.length > MCP_IDEMPOTENCY_MAX_KEY_LENGTH || id.length > MCP_IDEMPOTENCY_MAX_KEY_LENGTH) {
        return null;
      }
      return `jsonrpc:${clientKey}:${hashValue(method)}:${hashValue(id)}`;
    }
    return null;
  } catch {
    return null;
  }
}

function startMcpResponseCapture(res, entry) {
  const chunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = (chunk, encoding, cb) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    }
    return originalWrite(chunk, encoding, cb);
  };

  res.end = (chunk, encoding, cb) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    }
    return originalEnd(chunk, encoding, cb);
  };

  res.on("finish", () => {
    if (res.statusCode >= 500) {
      deleteMcpCacheEntry(entry.key);
      return;
    }
    const body = Buffer.concat(chunks);
    if (body.length > MCP_IDEMPOTENCY_MAX_BODY_BYTES) {
      deleteMcpCacheEntry(entry.key);
      return;
    }
    entry.status = "complete";
    entry.statusCode = res.statusCode;
    entry.headers = res.getHeaders();
    entry.body = body;
    entry.bodyLength = body.length;
    entry.expiresAt = Date.now() + MCP_IDEMPOTENCY_TTL_MS;
    mcpIdempotencyBytes += body.length;
    cleanupMcpIdempotencyCache();
  });
}

function replayMcpResponse(entry, res) {
  if (entry.headers) {
    for (const [key, value] of Object.entries(entry.headers)) {
      if (value !== undefined && key.toLowerCase() !== "content-length") {
        res.setHeader(key, value);
      }
    }
  }
  res.status(entry.statusCode || 200);
  res.end(entry.body || "");
}

async function main() {
  let directorToken = process.env.MCP_DIRECTOR_TOKEN || "";
  let authHeader = "";

  if (oauth.hasGoogleCredentials() && !oauth.hasAllowedEmails()) {
    console.warn("[mcp-http] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are set but ALLOWED_EMAILS is empty. MCP OAuth remains disabled until an explicit allowlist is configured.");
  }

  // When Google OAuth is configured, create a local session for the MCP HTTP
  // server so it can call the Express API on behalf of authenticated users.
  if (GOOGLE_OAUTH_ENABLED) {
    const email = process.env.ALLOWED_EMAILS
      ? process.env.ALLOWED_EMAILS.split(",")[0].trim()
      : "mcp-http@local";
    const sessionId = oauth.createSession(email, "MCP HTTP");
    authHeader = `Cookie: wc4_session=${sessionId}`;
  } else if (BASIC_AUTH_ENABLED) {
    authHeader = getBasicAuthHeader();
  }

  // Auto-authenticate in demo/mock mode
  if (!directorToken && CONTROLLER_IP === "mock") {
    const headers = { "Content-Type": "application/json" };
    if (authHeader) {
      if (authHeader.startsWith("Cookie:")) {
        headers["Cookie"] = authHeader.replace("Cookie: ", "");
      } else {
        headers["Authorization"] = authHeader;
      }
    }

    const loginData = await requestJson(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "demo@demo.com", password: "demo" }),
    });
    const accountToken = loginData.accountToken;

    const tokenData = await requestJson(`${BASE_URL}/api/auth/director-token`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accountToken, controllerCommonName: "mock-controller" }),
    });
    directorToken = tokenData.directorToken;
  }

  const mcpConfig = {
    baseUrl: BASE_URL,
    controllerIp: CONTROLLER_IP,
    directorToken,
    authHeader,
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use((err, _req, res, next) => {
    if (err instanceof SyntaxError || err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Invalid JSON request body" });
    }
    return next(err);
  });

  // Trust proxy only when explicitly configured
  if (process.env.TRUST_PROXY) {
    app.set("trust proxy", process.env.TRUST_PROXY);
  }

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  if (!GOOGLE_OAUTH_ENABLED) {
    app.use((req, res, next) => {
      if (BASIC_AUTH_ENABLED) {
        if (isValidBasicAuthHeader(req.headers.authorization || "")) return next();
        return sendBasicAuthChallenge(res, "WebControl4 MCP");
      }
      if (isLoopbackRequest(req)) return next();
      return res.status(403).json({ error: "MCP HTTP requires OAuth, Basic Auth, or loopback access" });
    });
  }

  // -------------------------------------------------------------------------
  // OAuth 2.0 Authorization Server endpoints (for MCP clients)
  // Only active when Google OAuth is configured.
  // -------------------------------------------------------------------------

  if (GOOGLE_OAUTH_ENABLED) {
    console.log("MCP OAuth enabled (Google login required for MCP clients)");

    function getSafeHost(req) {
      const host = req.headers.host || "";
      return /^[a-zA-Z0-9._:\[\]-]+$/.test(host) ? host : `localhost:${MCP_PORT}`;
    }

    // --- Authorization Server Metadata (RFC 8414) ---
    app.get("/.well-known/oauth-authorization-server", (req, res) => {
      const proto = req.protocol;
      const host = getSafeHost(req);
      const issuer = `${proto}://${host}`;
      res.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    });

    // --- Dynamic Client Registration (RFC 7591) ---
    app.post("/register", (req, res) => {
      const metadata = req.body || {};
      if (!metadata.redirect_uris || !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0) {
        return res.status(400).json({ error: "redirect_uris required" });
      }
      if (!metadata.redirect_uris.every((uri) => typeof uri === "string" && oauth.isValidRedirectUri(uri))) {
        return res.status(400).json({ error: "redirect_uris must be https or loopback http URLs" });
      }
      try {
        const client = oauth.registerClient(metadata);
        res.status(201).json(client);
      } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
      }
    });

    // --- Authorization Endpoint ---
    app.get("/authorize", (req, res) => {
      const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

      if (
        typeof client_id !== "string" ||
        typeof redirect_uri !== "string" ||
        typeof code_challenge !== "string" ||
        (state !== undefined && (typeof state !== "string" || state.length > 1024))
      ) {
        return res.status(400).json({ error: "Invalid authorization request parameters." });
      }

      if (response_type !== "code") {
        return res.status(400).json({ error: "Unsupported response_type. Use 'code'." });
      }

      const client = oauth.getClient(client_id);
      if (!client) {
        return res.status(400).json({ error: "Unknown client_id. Register first via POST /register." });
      }
      if (!oauth.clientAllowsRedirectUri(client, redirect_uri)) {
        return res.status(400).json({ error: "redirect_uri must exactly match a registered redirect URI." });
      }
      if (
        !code_challenge ||
        code_challenge_method !== "S256" ||
        !PKCE_S256_RE.test(String(code_challenge))
      ) {
        return res.status(400).json({ error: "PKCE with S256 code_challenge is required." });
      }

      let pendingId;
      try {
        // Store pending auth state, then redirect to Google
        pendingId = oauth.createPendingAuth({
          clientId: client_id,
          redirectUri: redirect_uri,
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method || "S256",
          clientState: state,
        });
      } catch (err) {
        return res.status(err.statusCode || 500).json({ error: err.message });
      }

      const proto = req.protocol;
      const host = getSafeHost(req);
      const googleCallback = `${proto}://${host}/auth/google/callback`;
      const googleState = `mcp:${pendingId}`;

      res.redirect(oauth.googleAuthUrl(googleCallback, googleState));
    });

    // --- Google OAuth Callback (MCP flow) ---
    app.get("/auth/google/callback", async (req, res) => {
      try {
        const { code, state } = req.query;
        if (typeof code !== "string" || !code) return res.status(400).json({ error: "Missing authorization code" });

        // Extract pending auth ID from state — must start with "mcp:" prefix
        const stateStr = typeof state === "string" ? state : "";
        if (!stateStr.startsWith("mcp:")) {
          return res.status(400).json({ error: "Invalid authorization state format" });
        }
        const pendingId = stateStr.slice(4);
        const pending = oauth.getPendingAuth(pendingId);
        if (!pending) {
          return res.status(400).json({ error: "Invalid or expired authorization state" });
        }

        const proto = req.protocol;
        const host = getSafeHost(req);
        const callbackUrl = `${proto}://${host}/auth/google/callback`;

        const tokens = await oauth.googleExchangeCode(code, callbackUrl);
        const user = await oauth.googleUserInfo(tokens.access_token);

        if (!oauth.isEmailAllowed(user.email)) {
          return res.status(403).json({ error: "Email not authorized. Check ALLOWED_EMAILS." });
        }

        // Create auth code for the MCP client
        const authCode = oauth.createAuthCode(
          pending.clientId,
          pending.redirectUri,
          pending.codeChallenge,
          pending.codeChallengeMethod,
          user.email
        );

        // Redirect to MCP client's redirect_uri with code
        const redirectUrl = new URL(pending.redirectUri);
        redirectUrl.searchParams.set("code", authCode);
        if (pending.clientState) {
          redirectUrl.searchParams.set("state", pending.clientState);
        }
        res.redirect(redirectUrl.toString());
      } catch (err) {
        console.error("MCP OAuth callback error:", err);
        res.status(500).json({ error: "Authentication failed. Please try again." });
      }
    });

    // --- Token Endpoint ---
    app.post("/token", (req, res) => {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "invalid_request" });
      }
      const { grant_type, code, code_verifier, client_id, client_secret } = req.body;

      // Validate client credentials (required for all grant types)
      const client = oauth.getClient(client_id);
      if (!client || !oauth.verifyClientSecret(client, client_secret)) {
        return res.status(401).json({ error: "invalid_client" });
      }

      if (grant_type === "authorization_code") {
        const { redirect_uri } = req.body;
        const tokenResponse = oauth.exchangeAuthCode(code, code_verifier, client_id, redirect_uri);
        if (!tokenResponse) {
          return res.status(400).json({ error: "invalid_grant" });
        }
        return res.json(tokenResponse);
      }

      if (grant_type === "refresh_token") {
        const { refresh_token } = req.body;
        if (!refresh_token) {
          return res.status(400).json({ error: "invalid_request", error_description: "refresh_token is required" });
        }
        const tokenResponse = oauth.refreshAccessToken(refresh_token, client_id);
        if (!tokenResponse) {
          return res.status(400).json({ error: "invalid_grant" });
        }
        return res.json(tokenResponse);
      }

      return res.status(400).json({ error: "unsupported_grant_type" });
    });

    // --- Protect /mcp with Bearer token ---
    app.use("/mcp", (req, res, next) => {
      // All methods require auth when OAuth is configured
      const token = oauth.getTokenFromReq(req);
      if (!token) {
        res.status(401).json({ error: "Bearer token required" });
        return;
      }
      // Propagate authenticated user identity to downstream handlers.
      // NOTE: All MCP users share the same Director token established at
      // startup (via the Control4 WebSocket connection). Per-user Director
      // tokens are not supported because the Director token comes from a
      // single persistent WebSocket connection, not per-request auth.
      // The user identity is attached here for logging/auditing purposes.
      req.mcpUser = { email: token.email, clientId: token.clientId };
      next();
    });
  }

  // -------------------------------------------------------------------------
  // MCP endpoint
  // -------------------------------------------------------------------------

  // Stateless mode: create a new server + transport per request
  app.post("/mcp", async (req, res) => {
    if (req.mcpUser) {
      console.log(`[MCP] Request from user: ${req.mcpUser.email || "unknown"} (client: ${req.mcpUser.clientId || "none"})`);
    }

    cleanupMcpIdempotencyCache();
    const requestKey = getMcpIdempotencyKey(req);
    const requestHash = requestKey ? getMcpRequestHash(req) : null;
    if (requestKey) {
      const cached = mcpIdempotencyCache.get(requestKey);
      if (cached?.status === "complete") {
        if (cached.requestHash !== requestHash) {
          return res.status(409).json({ error: "Idempotency key reused with different request body" });
        }
        mcpIdempotencyCache.delete(requestKey);
        mcpIdempotencyCache.set(requestKey, cached);
        return replayMcpResponse(cached, res);
      }
      if (cached?.status === "pending") {
        if (cached.requestHash !== requestHash) {
          return res.status(409).json({ error: "Idempotency key reused with different request body" });
        }
        return res.status(409).json({ error: "Duplicate MCP request already in progress" });
      }
    }

    if (requestKey && mcpIdempotencyCache.size >= MCP_IDEMPOTENCY_MAX_ENTRIES) {
      evictOldestMcpEntry((entry) => entry.status === "complete");
      if (mcpIdempotencyCache.size >= MCP_IDEMPOTENCY_MAX_ENTRIES) {
        return res.status(429).json({ error: "Too many idempotent MCP requests in progress" });
      }
    }

    const cacheEntry = requestKey ? {
      key: requestKey,
      status: "pending",
      requestHash,
      expiresAt: Date.now() + MCP_IDEMPOTENCY_PENDING_TTL_MS,
    } : null;
    if (requestKey && cacheEntry) {
      mcpIdempotencyCache.set(requestKey, cacheEntry);
      startMcpResponseCapture(res, cacheEntry);
    }

    const server = createMcpServer(mcpConfig);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      if (requestKey) {
        const cached = mcpIdempotencyCache.get(requestKey);
        if (cached?.status === "pending") {
          mcpIdempotencyCache.delete(requestKey);
        }
      }
      transport.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (requestKey) {
        deleteMcpCacheEntry(requestKey);
      }
      console.error("[MCP] Request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request failed" });
      } else {
        res.destroy(err);
      }
    }
  });

  // GET and DELETE not supported in stateless mode
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed. Use POST." });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed. Use POST." });
  });

  app.listen(MCP_PORT, () => {
    console.log(`MCP HTTP server running at http://localhost:${MCP_PORT}/mcp`);
    if (GOOGLE_OAUTH_ENABLED) {
      console.log(`OAuth metadata: http://localhost:${MCP_PORT}/.well-known/oauth-authorization-server`);
    } else if (!BASIC_AUTH_ENABLED) {
      console.log("MCP HTTP is restricted to loopback clients until OAuth or Basic Auth is configured.");
    }
  });
}

main().catch((err) => {
  console.error("MCP HTTP server failed:", err);
  process.exit(1);
});
