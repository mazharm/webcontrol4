#!/usr/bin/env node
// ---------------------------------------------------------------------------
// MCP Server – STDIO transport (for Claude Desktop)
// ---------------------------------------------------------------------------
// Requires the Express server to be running on localhost.
//
// Usage:   node mcp-stdio.js
// Env:     MCP_CONTROLLER_IP  (default: "mock")
//          MCP_DIRECTOR_TOKEN (auto-auths in demo/mock mode if empty)
//          MCP_BASE_URL       (default: auto-detect from .env)
//          GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (for OAuth)

require("dotenv").config();

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createMcpServer } = require("./mcp-server.js");
const { requestJson } = require("./http-client");
const oauth = require("./oauth");

const BASE_URL = process.env.MCP_BASE_URL || (
  process.env.HTTPS_ENABLED === "true"
    ? `https://localhost:${process.env.HTTPS_PORT || 3443}`
    : `http://localhost:${process.env.PORT || 3000}`
);
const CONTROLLER_IP = process.env.MCP_CONTROLLER_IP || "mock";

async function main() {
  let directorToken = process.env.MCP_DIRECTOR_TOKEN || "";
  let authHeader = "";

  // When Google OAuth is configured, create a session for the STDIO MCP server
  // so it can authenticate to the Express API. The STDIO server runs locally,
  // so we trust it implicitly — it creates a session using the configured
  // allowed email (or a fallback).
  if (oauth.isConfigured()) {
    const email = process.env.ALLOWED_EMAILS
      ? process.env.ALLOWED_EMAILS.split(",")[0].trim()
      : "mcp-stdio@local";
    const sessionId = oauth.createSession(email, "MCP STDIO");
    authHeader = `Cookie: wc4_session=${sessionId}`;
  }

  // Auto-authenticate in demo/mock mode
  if (!directorToken && CONTROLLER_IP === "mock") {
    const headers = { "Content-Type": "application/json" };
    // For OAuth mode, include session cookie as a header
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

  const server = createMcpServer({
    baseUrl: BASE_URL,
    controllerIp: CONTROLLER_IP,
    directorToken,
    authHeader,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP STDIO server failed:", err);
  process.exit(1);
});
