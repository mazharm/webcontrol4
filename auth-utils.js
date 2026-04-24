const crypto = require("crypto");

const BASIC_AUTH_USERNAME = process.env.AUTH_USERNAME || "";
const BASIC_AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";

function hasBasicAuthConfigured() {
  return !!(BASIC_AUTH_USERNAME && BASIC_AUTH_PASSWORD);
}

function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseBasicAuthHeader(header) {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
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
  const ip = getRemoteIp(req);
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function sendBasicAuthChallenge(res, realm = "WebControl4") {
  res.setHeader("WWW-Authenticate", `Basic realm="${realm}", charset="UTF-8"`);
  res.status(401).send("Authentication required");
}

module.exports = {
  hasBasicAuthConfigured,
  isValidBasicAuthHeader,
  getBasicAuthHeader,
  isLoopbackRequest,
  sendBasicAuthChallenge,
};
