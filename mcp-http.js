#!/usr/bin/env node
// ---------------------------------------------------------------------------
// MCP Server – Streamable HTTP transport (for ChatGPT / Claude.ai)
// ---------------------------------------------------------------------------
// Runs its own Express server on port 3001.  The main Express server must
// also be running (default http://localhost:3000).
//
// Usage:   node mcp-http.js
// Env:     MCP_HTTP_PORT      (default: 3001)
//          MCP_CONTROLLER_IP  (default: "mock")
//          MCP_DIRECTOR_TOKEN (auto-auths in demo/mock mode if empty)
//          MCP_BASE_URL       (default: "http://localhost:3000")
//          GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (for OAuth)

require("dotenv").config();

const express = require("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpServer } = require("./mcp-server.js");
const { requestJson } = require("./http-client");
const oauth = require("./oauth");

const MCP_PORT = parseInt(process.env.MCP_HTTP_PORT, 10) || 3001;
const BASE_URL = process.env.MCP_BASE_URL || (
  process.env.HTTPS_ENABLED === "true"
    ? `https://localhost:${process.env.HTTPS_PORT || 3443}`
    : `http://localhost:${process.env.PORT || 3000}`
);
const CONTROLLER_IP = process.env.MCP_CONTROLLER_IP || "mock";
const PKCE_S256_RE = /^[A-Za-z0-9\-_]{43,128}$/;

async function main() {
  let directorToken = process.env.MCP_DIRECTOR_TOKEN || "";
  let authHeader = "";

  // When Google OAuth is configured, create a local session for the MCP HTTP
  // server so it can call the Express API on behalf of authenticated users.
  if (oauth.isConfigured()) {
    const email = process.env.ALLOWED_EMAILS
      ? process.env.ALLOWED_EMAILS.split(",")[0].trim()
      : "mcp-http@local";
    const sessionId = oauth.createSession(email, "MCP HTTP");
    authHeader = `Cookie: wc4_session=${sessionId}`;
  }

  // Auto-authenticate in demo/mock mode
  if (!directorToken && CONTROLLER_IP === "mock") {
    const headers = { "Content-Type": "application/json" };
    if (authHeader.startsWith("Cookie:")) {
      headers["Cookie"] = authHeader.replace("Cookie: ", "");
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

  // -------------------------------------------------------------------------
  // OAuth 2.0 Authorization Server endpoints (for MCP clients)
  // Only active when Google OAuth is configured.
  // -------------------------------------------------------------------------

  if (oauth.isConfigured()) {
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
        grant_types_supported: ["authorization_code"],
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
        res.status(500).json({ error: err.message });
      }
    });

    // --- Authorization Endpoint ---
    app.get("/authorize", (req, res) => {
      const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

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

      // Store pending auth state, then redirect to Google
      const pendingId = oauth.createPendingAuth({
        clientId: client_id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method || "S256",
        clientState: state,
      });

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
        if (!code) return res.status(400).json({ error: "Missing authorization code" });

        // Extract pending auth ID from state
        const pendingId = (state || "").replace(/^mcp:/, "");
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
      const { grant_type, code, code_verifier, client_id, client_secret } = req.body;

      if (grant_type !== "authorization_code") {
        return res.status(400).json({ error: "unsupported_grant_type" });
      }

      // Validate client credentials
      const client = oauth.getClient(client_id);
      if (!client || !oauth.verifyClientSecret(client, client_secret)) {
        return res.status(401).json({ error: "invalid_client" });
      }

      const { redirect_uri } = req.body;
      const tokenResponse = oauth.exchangeAuthCode(code, code_verifier, client_id, redirect_uri);
      if (!tokenResponse) {
        return res.status(400).json({ error: "invalid_grant" });
      }

      res.json(tokenResponse);
    });

    // --- Protect /mcp with Bearer token ---
    app.use("/mcp", (req, res, next) => {
      // All methods require auth when OAuth is configured
      const token = oauth.getTokenFromReq(req);
      if (!token) {
        res.status(401).json({ error: "Bearer token required" });
        return;
      }
      next();
    });
  }

  // -------------------------------------------------------------------------
  // MCP endpoint
  // -------------------------------------------------------------------------

  // Stateless mode: create a new server + transport per request
  app.post("/mcp", async (req, res) => {
    const server = createMcpServer(mcpConfig);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
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
    if (oauth.isConfigured()) {
      console.log(`OAuth metadata: http://localhost:${MCP_PORT}/.well-known/oauth-authorization-server`);
    }
  });
}

main().catch((err) => {
  console.error("MCP HTTP server failed:", err);
  process.exit(1);
});
