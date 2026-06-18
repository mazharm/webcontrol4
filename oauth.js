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
const CLIENT_IDLE_TTL    = 30 * 24 * 3600 * 1000;  // 30 days
const MAX_CLIENTS        = 100;                     // max registered OAuth clients
const MAX_SESSIONS       = 1000;
const MAX_AUTH_CODES     = 500;
const MAX_ACCESS_TOKENS  = 1000;
const MAX_REFRESH_TOKENS = 1000;
const MAX_PENDING_AUTHS  = 500;
const MAX_PENDING_AUTHS_PER_CLIENT = 25;
const MAX_REDIRECT_URIS_PER_CLIENT = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_CLIENT_METADATA_VALUES = 10;

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

function limitError(message) {
  const err = new Error(message);
  err.statusCode = 429;
  err.code = "limit_exceeded";
  return err;
}

function metadataError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = "invalid_client_metadata";
  return err;
}

function deleteOldest(map, predicate = () => true, onDelete) {
  for (const [key, value] of map) {
    if (!predicate(value, key)) continue;
    map.delete(key);
    if (onDelete) onDelete(value, key);
    return true;
  }
  return false;
}

function setBounded(map, key, value, max, onEvict) {
  while (map.size >= max) {
    if (!deleteOldest(map, () => true, onEvict)) break;
  }
  map.set(key, value);
}

function clientHasLiveState(clientId) {
  const hasClientId = (entry) => entry && entry.clientId === clientId;
  for (const entry of pendingAuths.values()) if (hasClientId(entry)) return true;
  for (const entry of authCodes.values()) if (hasClientId(entry)) return true;
  for (const entry of accessTokens.values()) if (hasClientId(entry)) return true;
  for (const entry of refreshTokens.values()) if (hasClientId(entry)) return true;
  return false;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isConfigured() {
  return hasGoogleCredentials() && hasAllowedEmails();
}

function hasGoogleCredentials() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function hasAllowedEmails() {
  return ALLOWED_EMAILS.length > 0;
}

function isEmailAllowed(email) {
  if (!hasAllowedEmails()) return false;
  if (typeof email !== "string") return false;
  return ALLOWED_EMAILS.includes(email.toLowerCase());
}

function isValidRedirectUri(redirectUri) {
  if (typeof redirectUri !== "string" || redirectUri.length > MAX_REDIRECT_URI_LENGTH) return false;
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
  cleanupExpired();
  setBounded(sessions, id, { email, name, expiresAt: Date.now() + SESSION_TTL }, MAX_SESSIONS);
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
  for (const [id, s] of sessions)     { if (now > s.expiresAt)  sessions.delete(id); }
  for (const [id, p] of pendingAuths) { if (now > p.expiresAt)  pendingAuths.delete(id); }
  for (const [id, c] of authCodes)    { if (now > c.expiresAt)  authCodes.delete(id); }
  for (const [id, t] of accessTokens) { if (now > t.expiresAt)  accessTokens.delete(id); }
  // Clean up refresh tokens that have exceeded their own TTL
  for (const [id, rt] of refreshTokens) {
    if (now > rt.expiresAt) {
      refreshTokens.delete(id);
      if (rt.accessToken) accessTokens.delete(rt.accessToken);
    }
  }
  for (const [id, client] of registeredClients) {
    if (client.expiresAt && now > client.expiresAt && !clientHasLiveState(id)) {
      registeredClients.delete(id);
    }
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
  if (!metadata || typeof metadata !== "object") {
    throw metadataError("Invalid client metadata");
  }
  cleanupExpired();
  if (registeredClients.size >= MAX_CLIENTS) {
    deleteOldest(registeredClients, (_client, clientId) => !clientHasLiveState(clientId));
  }
  if (registeredClients.size >= MAX_CLIENTS) {
    throw limitError("Maximum number of registered clients reached");
  }

  if (Array.isArray(metadata.redirect_uris) && metadata.redirect_uris.length > MAX_REDIRECT_URIS_PER_CLIENT) {
    throw metadataError(`At most ${MAX_REDIRECT_URIS_PER_CLIENT} redirect_uris are allowed`);
  }

  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((uri) => typeof uri === "string" && isValidRedirectUri(uri))
    : [];
  const clientName = typeof metadata.client_name === "string" && metadata.client_name.trim()
    ? metadata.client_name.trim().slice(0, MAX_CLIENT_NAME_LENGTH)
    : "Unknown";
  const grantTypes = Array.isArray(metadata.grant_types)
    ? metadata.grant_types.filter((v) => typeof v === "string").slice(0, MAX_CLIENT_METADATA_VALUES)
    : ["authorization_code"];
  const responseTypes = Array.isArray(metadata.response_types)
    ? metadata.response_types.filter((v) => typeof v === "string").slice(0, MAX_CLIENT_METADATA_VALUES)
    : ["code"];

  const clientId = randomId();
  const clientSecret = randomId();
  const now = Date.now();
  registeredClients.set(clientId, {
    clientSecret,
    redirectUris,
    clientName,
    grantTypes,
    responseTypes,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + CLIENT_IDLE_TTL,
  });
  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: "client_secret_post",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
  };
}

function getClient(clientId) {
  cleanupExpired();
  const client = registeredClients.get(clientId);
  if (!client) return null;
  const now = Date.now();
  client.lastSeenAt = now;
  client.expiresAt = now + CLIENT_IDLE_TTL;
  return client;
}

function verifyClientSecret(client, secret) {
  if (!client || !secret) return false;
  return timingSafeEqual(client.clientSecret, String(secret));
}

// ---------------------------------------------------------------------------
// MCP OAuth: Pending auth (tracks state while user is at Google)
// ---------------------------------------------------------------------------

function createPendingAuth(params) {
  cleanupExpired();
  const clientId = params?.clientId;
  let clientPendingCount = 0;
  for (const pending of pendingAuths.values()) {
    if (pending.clientId === clientId) clientPendingCount += 1;
  }
  while (clientPendingCount >= MAX_PENDING_AUTHS_PER_CLIENT) {
    if (!deleteOldest(pendingAuths, (pending) => pending.clientId === clientId)) break;
    clientPendingCount -= 1;
  }
  const id = randomId();
  setBounded(pendingAuths, id, { ...params, expiresAt: Date.now() + CODE_TTL }, MAX_PENDING_AUTHS);
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
  cleanupExpired();
  const code = randomId();
  setBounded(authCodes, code, {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    email,
    expiresAt: Date.now() + CODE_TTL,
  }, MAX_AUTH_CODES);
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
  // Verify redirect_uri matches the one used during authorization.  When a
  // redirect_uri was registered at /authorize it MUST be presented again and
  // match exactly (RFC 6749 §4.1.3) — otherwise an attacker who intercepts an
  // auth code could redeem it without binding to the original redirect.
  if (c.redirectUri && c.redirectUri !== redirectUri) return null;

  // Verify PKCE (only S256 is supported)
  if (c.codeChallenge) {
    if (c.codeChallengeMethod !== "S256") return null; // reject non-S256 methods
    // RFC 7636 §4.1: code_verifier is 43-128 chars from the unreserved set.
    // Validating the type/format also prevents a non-string body value from
    // throwing inside crypto.update() (→ 500).
    if (typeof codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
      return null;
    }
    const hash = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    if (!timingSafeEqual(hash, c.codeChallenge)) return null;
  }

  authCodes.delete(code); // one-time use

  const accessToken = randomId();
  const refreshToken = randomId();
  setBounded(accessTokens, accessToken, {
    clientId,
    email: c.email,
    expiresAt: Date.now() + TOKEN_TTL,
  }, MAX_ACCESS_TOKENS);
  setBounded(refreshTokens, refreshToken, {
    clientId,
    email: c.email,
    accessToken,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL,
  }, MAX_REFRESH_TOKENS, (rt) => {
    if (rt.accessToken) accessTokens.delete(rt.accessToken);
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
  // Reject (and revoke) expired refresh tokens immediately — the periodic
  // cleanup leaves a window in which an expired token would otherwise still
  // mint a fresh access token.
  if (rt.expiresAt && Date.now() > rt.expiresAt) {
    refreshTokens.delete(oldRefreshToken);
    if (rt.accessToken) accessTokens.delete(rt.accessToken);
    return null;
  }

  // Revoke old tokens
  accessTokens.delete(rt.accessToken);
  refreshTokens.delete(oldRefreshToken);

  // Issue new pair
  const newAccessToken = randomId();
  const newRefreshToken = randomId();
  setBounded(accessTokens, newAccessToken, {
    clientId,
    email: rt.email,
    expiresAt: Date.now() + TOKEN_TTL,
  }, MAX_ACCESS_TOKENS);
  setBounded(refreshTokens, newRefreshToken, {
    clientId,
    email: rt.email,
    accessToken: newAccessToken,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL,
  }, MAX_REFRESH_TOKENS, (oldRt) => {
    if (oldRt.accessToken) accessTokens.delete(oldRt.accessToken);
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
  hasGoogleCredentials,
  hasAllowedEmails,
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
