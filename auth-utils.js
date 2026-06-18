const crypto = require("crypto");
const net = require("net");

const BASIC_AUTH_USERNAME = process.env.AUTH_USERNAME || "";
const BASIC_AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";

function hasBasicAuthConfigured() {
  return !!(BASIC_AUTH_USERNAME && BASIC_AUTH_PASSWORD);
}

function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function parseBasicAuthHeader(header) {
  if (typeof header !== "string" || header.length > 4096) return null;
  const match = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return null;
    return {
      username: decoded.slice(0, sep),
      password: decoded.slice(sep + 1),
    };
  } catch {
    return null;
  }
}

function isValidBasicAuthHeader(header) {
  if (!hasBasicAuthConfigured()) return false;
  const creds = parseBasicAuthHeader(header);
  if (!creds) return false;
  return timingSafeEqualString(creds.username, BASIC_AUTH_USERNAME)
    && timingSafeEqualString(creds.password, BASIC_AUTH_PASSWORD);
}

function getBasicAuthHeader() {
  if (!hasBasicAuthConfigured()) return "";
  return `Basic ${Buffer.from(`${BASIC_AUTH_USERNAME}:${BASIC_AUTH_PASSWORD}`, "utf8").toString("base64")}`;
}

function getRemoteIp(req) {
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
}

function isLoopbackRequest(req) {
  const ip = String(getRemoteIp(req)).replace(/^\[|\]$/g, "");
  if (ip.startsWith("::ffff:")) {
    return isLoopbackIPv4(ip.slice(7));
  }
  if (net.isIP(ip) === 4) return isLoopbackIPv4(ip);
  return ip === "::1";
}

function isLoopbackIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  return Number(ip.split(".")[0]) === 127;
}

function sanitizeRealm(realm) {
  return String(realm || "WebControl4").replace(/[\r\n"\\]/g, "");
}

function sendBasicAuthChallenge(res, realm = "WebControl4") {
  res.setHeader("WWW-Authenticate", `Basic realm="${sanitizeRealm(realm)}", charset="UTF-8"`);
  res.status(401).send("Authentication required");
}

module.exports = {
  hasBasicAuthConfigured,
  isValidBasicAuthHeader,
  getBasicAuthHeader,
  isLoopbackRequest,
  sendBasicAuthChallenge,
};
