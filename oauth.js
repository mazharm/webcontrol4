// ---------------------------------------------------------------------------
// OAuth module – Google OAuth + MCP OAuth 2.0 Authorization Server
// ---------------------------------------------------------------------------
// Used by server.js (web app auth) and mcp-http.js (MCP client auth).
// All state is in-memory; tokens/sessions are lost on restart.

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Configuration (read from process.env – dotenv must be loaded beforehand)
// ---------------------------------------------------------------------------

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const ALLOWED_EMAILS       = process.env.ALLOWED_EMAILS
  ? process.env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase())
  : [];

const SESSION_TTL        = 24 * 3600 * 1000;        // 24 hours
const CODE_TTL           = 10 * 60 * 1000;          // 10 minutes
const TOKEN_TTL          = 3600 * 1000;             // 1 hour
const REFRESH_TOKEN_TTL  = 30 * 24 * 3600 * 1000;  // 30 days
const MAX_CLIENTS        = 100;                     // max registered OAuth clients

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const sessions          = new Map(); // sessionId → { email, name, expiresAt }
const authCodes         = new Map(); // code → { clientId, redirectUri, codeChallenge, codeChallengeMethod, email, expiresAt }
const accessTokens      = new Map(); // token → { clientId, email, expiresAt }
const refreshTokens     = new Map(); // refreshToken → { clientId, email, accessToken, expiresAt }
const registeredClients = new Map(); // clientId → { clientSecret, redirectUris, clientName, ... }
const pendingAuths      = new Map(); // stateId → { clientId, redirectUri, codeChallenge, codeChallengeMethod, state, expiresAt }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId() {
  return crypto.randomBytes(32).toString("hex");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function isEmailAllowed(email) {
  if (ALLOWED_EMAILS.length === 0) return true;
  return ALLOWED_EMAILS.includes(email.toLowerCase());
}

function isValidRedirectUri(redirectUri) {
  try {
    const parsed = new URL(redirectUri);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (parsed.hash) return false;

    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol === "https:") return true;

    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function clientAllowsRedirectUri(client, redirectUri) {
  if (!client || !redirectUri || !Array.isArray(client.redirectUris)) return false;
  return client.redirectUris.includes(redirectUri) && isValidRedirectUri(redirectUri);
}

// ---------------------------------------------------------------------------
// Google OAuth helpers
// ---------------------------------------------------------------------------

function googleAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "offline",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function googleExchangeCode(code, redirectUri) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${text}`);
  }
  return res.json();
}

async function googleUserInfo(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to get Google user info");
  return res.json();
}

// ---------------------------------------------------------------------------
// Session management (web app)
// ---------------------------------------------------------------------------

function createSession(email, name) {
  const id = randomId();
  sessions.set(id, { email, name, expiresAt: Date.now() + SESSION_TTL });
  return id;
}

function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(id);
    return null;
  }
  return s;
}

function deleteSession(id) {
  sessions.delete(id);
}

function getSessionFromReq(req) {
  const cookies = req.headers.cookie || "";
  const m = cookies.match(/wc4_session=([^;]+)/);
  return m ? getSession(m[1]) : null;
}

function getSessionIdFromReq(req) {
  const cookies = req.headers.cookie || "";
  const m = cookies.match(/wc4_session=([^;]+)/);
  return m ? m[1] : null;
}

function setSessionCookie(res, sessionId, secure) {
  const parts = [
    `wc4_session=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "wc4_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

// ---------------------------------------------------------------------------
// Cleanup – remove expired in-memory entries to prevent unbounded growth
// ---------------------------------------------------------------------------

function cleanupExpired() {
  const now = Date.now();
  for (const [id, s] of Array.from(sessions))     { if (now > s.expiresAt)  sessions.delete(id); }
  for (const [id, p] of Array.from(pendingAuths)) { if (now > p.expiresAt)  pendingAuths.delete(id); }
  for (const [id, c] of Array.from(authCodes))    { if (now > c.expiresAt)  authCodes.delete(id); }
  for (const [id, t] of Array.from(accessTokens)) { if (now > t.expiresAt)  accessTokens.delete(id); }
  // Clean up refresh tokens that have exceeded their own TTL
  for (const [id, rt] of Array.from(refreshTokens)) {
    if (now > rt.expiresAt) refreshTokens.delete(id);
  }
}

// Run cleanup every 15 minutes
setInterval(cleanupExpired, 15 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Bearer token validation (MCP access tokens)
// ---------------------------------------------------------------------------

function getTokenFromReq(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return validateAccessToken(token);
}

function validateAccessToken(token) {
  const info = accessTokens.get(token);
  if (!info) return null;
  if (Date.now() > info.expiresAt) {
    accessTokens.delete(token);
    return null;
  }
  return info;
}

// ---------------------------------------------------------------------------
// MCP OAuth: Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

function registerClient(metadata) {
  if (registeredClients.size >= MAX_CLIENTS) {
    throw new Error("Maximum number of registered clients reached");
  }

  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((uri) => typeof uri === "string" && isValidRedirectUri(uri))
    : [];

  const clientId = randomId();
  const clientSecret = randomId();
  registeredClients.set(clientId, {
    clientSecret,
    redirectUris,
    clientName: metadata.client_name || "Unknown",
    grantTypes: metadata.grant_types || ["authorization_code"],
    responseTypes: metadata.response_types || ["code"],
  });
  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: metadata.client_name,
    redirect_uris: redirectUris,
    grant_types: metadata.grant_types || ["authorization_code"],
    response_types: metadata.response_types || ["code"],
    token_endpoint_auth_method: "client_secret_post",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
  };
}

function getClient(clientId) {
  return registeredClients.get(clientId) || null;
}

function verifyClientSecret(client, secret) {
  if (!client || !secret) return false;
  return timingSafeEqual(client.clientSecret, String(secret));
}

// ---------------------------------------------------------------------------
// MCP OAuth: Pending auth (tracks state while user is at Google)
// ---------------------------------------------------------------------------

function createPendingAuth(params) {
  const id = randomId();
  pendingAuths.set(id, { ...params, expiresAt: Date.now() + CODE_TTL });
  return id;
}

function getPendingAuth(id) {
  if (!id) return null;
  const p = pendingAuths.get(id);
  if (!p) return null;
  if (Date.now() > p.expiresAt) {
    pendingAuths.delete(id);
    return null;
  }
  pendingAuths.delete(id); // one-time use
  return p;
}

// ---------------------------------------------------------------------------
// MCP OAuth: Authorization codes
// ---------------------------------------------------------------------------

function createAuthCode(clientId, redirectUri, codeChallenge, codeChallengeMethod, email) {
  const code = randomId();
  authCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    email,
    expiresAt: Date.now() + CODE_TTL,
  });
  return code;
}

function exchangeAuthCode(code, codeVerifier, clientId, redirectUri) {
  const c = authCodes.get(code);
  if (!c) return null;
  if (Date.now() > c.expiresAt) {
    authCodes.delete(code);
    return null;
  }
  if (c.clientId !== clientId) return null;
  // Verify redirect_uri matches the one used during authorization
  if (c.redirectUri && redirectUri && c.redirectUri !== redirectUri) return null;

  // Verify PKCE (only S256 is supported)
  if (c.codeChallenge) {
    if (c.codeChallengeMethod !== "S256") return null; // reject non-S256 methods
    if (!codeVerifier) return null;
    const hash = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    if (!timingSafeEqual(hash, c.codeChallenge)) return null;
  }

  authCodes.delete(code); // one-time use

  const accessToken = randomId();
  const refreshToken = randomId();
  accessTokens.set(accessToken, {
    clientId,
    email: c.email,
    expiresAt: Date.now() + TOKEN_TTL,
  });
  refreshTokens.set(refreshToken, {
    clientId,
    email: c.email,
    accessToken,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL,
  });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(TOKEN_TTL / 1000),
    refresh_token: refreshToken,
  };
}

/**
 * Exchange a refresh token for a new access + refresh token pair.
 * Revokes the old access token and old refresh token atomically.
 */
function refreshAccessToken(oldRefreshToken, clientId) {
  const rt = refreshTokens.get(oldRefreshToken);
  if (!rt) return null;
  if (rt.clientId !== clientId) return null;

  // Revoke old tokens
  accessTokens.delete(rt.accessToken);
  refreshTokens.delete(oldRefreshToken);

  // Issue new pair
  const newAccessToken = randomId();
  const newRefreshToken = randomId();
  accessTokens.set(newAccessToken, {
    clientId,
    email: rt.email,
    expiresAt: Date.now() + TOKEN_TTL,
  });
  refreshTokens.set(newRefreshToken, {
    clientId,
    email: rt.email,
    accessToken: newAccessToken,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL,
  });

  return {
    access_token: newAccessToken,
    token_type: "Bearer",
    expires_in: Math.floor(TOKEN_TTL / 1000),
    refresh_token: newRefreshToken,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  isConfigured,
  isEmailAllowed,

  // Google OAuth
  googleAuthUrl,
  googleExchangeCode,
  googleUserInfo,

  // Sessions (web app)
  createSession,
  getSession,
  deleteSession,
  getSessionFromReq,
  getSessionIdFromReq,
  setSessionCookie,
  clearSessionCookie,

  // Bearer tokens (MCP)
  getTokenFromReq,
  validateAccessToken,

  // MCP OAuth AS
  registerClient,
  getClient,
  verifyClientSecret,
  isValidRedirectUri,
  clientAllowsRedirectUri,
  createPendingAuth,
  getPendingAuth,
  createAuthCode,
  exchangeAuthCode,
  refreshAccessToken,

  // Maintenance
  cleanupExpired,
};
