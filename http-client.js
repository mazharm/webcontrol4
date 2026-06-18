const http = require("http");
const https = require("https");
const net = require("net");

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

function isPrivateIPv4(ip) {
  const parts = ip.split(".");
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^\d+$/.test(p) || (p.length > 1 && p.startsWith("0")) || Number(p) > 255)
  ) {
    return false;
  }
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

function isPrivateOrLocalHost(hostname) {
  if (!hostname) return false;

  const normalized = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost") return true;

  const ipVersion = net.isIP(normalized);

  // IPv6 literals only — string-prefix checks below must never run against an
  // arbitrary DNS hostname (e.g. "fd.attacker.com" must NOT be treated as a
  // private fd00::/8 address, which would bypass the SSRF allowlist and
  // disable TLS verification).
  if (ipVersion === 6) {
    if (normalized === "::1" || normalized === "::") return true;

    // IPv4-mapped IPv6 (::ffff:x.x.x.x)
    if (normalized.startsWith("::ffff:")) {
      return isPrivateIPv4(normalized.slice(7));
    }

    // IPv6 unique local (fc00::/7) and link-local (fe80::/10)
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) {
      return true;
    }
    return false;
  }

  // IPv4 literals
  if (ipVersion === 4) {
    if (normalized === "0.0.0.0") return true;
    return isPrivateIPv4(normalized);
  }

  // Not an IP literal and not "localhost" → treat as a public hostname.
  return false;
}

const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "proxy-authorization",
  "x-director-token",
  "x-director-ip",
];

function filterRedirectHeaders(headers, fromUrl, toUrl) {
  if (fromUrl.origin === toUrl.origin) {
    return { ...headers };
  }

  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.includes(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function validateHttpUrl(parsed) {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
}

function shouldBlockRedirect(initialIsPrivate, redirectUrl) {
  return Boolean(initialIsPrivate) !== isPrivateOrLocalHost(redirectUrl.hostname);
}

function removeHeader(headers, headerName) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === headerName) delete headers[key];
  }
}

function buildRedirectOptions(options, headers, parsed, redirectUrl, statusCode) {
  const nextHeaders = filterRedirectHeaders(headers, parsed, redirectUrl);
  const nextOptions = { ...options, headers: nextHeaders };
  const method = String(options.method || "GET").toUpperCase();
  if ([301, 302, 303].includes(statusCode) && method !== "GET" && method !== "HEAD") {
    nextOptions.method = "GET";
    delete nextOptions.body;
    removeHeader(nextHeaders, "content-length");
    removeHeader(nextHeaders, "content-type");
  }
  return nextOptions;
}

function requestText(url, options = {}, redirectCount = 0) {
  // Track whether the initial request targeted a private host. Redirects may
  // follow within the same private/public trust boundary, but not across it.
  if (redirectCount === 0) {
    const initialParsed = new URL(url);
    validateHttpUrl(initialParsed);
    options = { ...options, _initialIsPrivate: isPrivateOrLocalHost(initialParsed.hostname) };
  }

  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error("Too many redirects"));
    }

    const parsed = new URL(url);
    validateHttpUrl(parsed);
    const headers = { ...(options.headers || {}) };
    const bodyBuf =
      typeof options.body === "string" || Buffer.isBuffer(options.body)
        ? Buffer.from(options.body)
        : null;

    if (bodyBuf) {
      headers["Content-Length"] = bodyBuf.length;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const reqOptions = {
      method: options.method || "GET",
      headers,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      rejectUnauthorized: parsed.protocol === "https:" ? !isPrivateOrLocalHost(parsed.hostname) : undefined,
    };
    if (options.agent !== undefined) reqOptions.agent = options.agent;
    const req = client.request(
      parsed,
      reqOptions,
      (res) => {
        if (REDIRECT_STATUSES.includes(res.statusCode) && res.headers.location) {
          let redirectUrl;
          try {
            redirectUrl = new URL(res.headers.location, parsed);
            validateHttpUrl(redirectUrl);
          } catch (err) {
            res.resume();
            return reject(err);
          }
          // Prevent SSRF / credential exfiltration across trust boundaries:
          // local/private requests may only redirect to local/private targets,
          // and public requests may not be bounced into private networks.
          if (shouldBlockRedirect(options._initialIsPrivate, redirectUrl)) {
            res.resume();
            return resolve({ statusCode: 403, body: "Redirect across private/public boundary blocked" });
          }
          res.resume();
          return resolve(
            requestText(
              redirectUrl.href,
              buildRedirectOptions(options, headers, parsed, redirectUrl, res.statusCode),
              redirectCount + 1
            )
          );
        }

        const maxResponseSize = options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
        let body = "";
        let totalSize = 0;
        let destroyed = false;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          totalSize += Buffer.byteLength(chunk, "utf8");
          if (totalSize > maxResponseSize) {
            destroyed = true;
            req.destroy(new Error("Response body too large"));
            return;
          }
          body += chunk;
        });
        res.on("end", () => {
          if (!destroyed) resolve({ statusCode: res.statusCode || 0, headers: res.headers, body });
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function requestJson(url, options = {}) {
  const response = await requestText(url, options);
  let json = null;
  try {
    json = JSON.parse(response.body);
  } catch {}

  if (response.statusCode >= 400) {
    const detail = json?.error?.message || response.body;
    throw new Error(`HTTP ${response.statusCode}: ${detail}`);
  }

  return json ?? { raw: response.body };
}

function requestBinary(url, options = {}, redirectCount = 0) {
  if (redirectCount === 0) {
    const initialParsed = new URL(url);
    validateHttpUrl(initialParsed);
    options = { ...options, _initialIsPrivate: isPrivateOrLocalHost(initialParsed.hostname) };
  }

  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error("Too many redirects"));
    }

    const parsed = new URL(url);
    validateHttpUrl(parsed);
    const headers = { ...(options.headers || {}) };
    const bodyBuf =
      typeof options.body === "string" || Buffer.isBuffer(options.body)
        ? Buffer.from(options.body)
        : null;

    if (bodyBuf) {
      headers["Content-Length"] = bodyBuf.length;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const reqOptions = {
      method: options.method || "GET",
      headers,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      rejectUnauthorized: parsed.protocol === "https:" ? !isPrivateOrLocalHost(parsed.hostname) : undefined,
    };
    if (options.agent !== undefined) reqOptions.agent = options.agent;
    const req = client.request(
      parsed,
      reqOptions,
      (res) => {
        if (REDIRECT_STATUSES.includes(res.statusCode) && res.headers.location) {
          let redirectUrl;
          try {
            redirectUrl = new URL(res.headers.location, parsed);
            validateHttpUrl(redirectUrl);
          } catch (err) {
            res.resume();
            return reject(err);
          }
          if (shouldBlockRedirect(options._initialIsPrivate, redirectUrl)) {
            res.resume();
            return resolve({ statusCode: 403, body: Buffer.alloc(0) });
          }
          res.resume();
          return resolve(
            requestBinary(
              redirectUrl.href,
              buildRedirectOptions(options, headers, parsed, redirectUrl, res.statusCode),
              redirectCount + 1
            )
          );
        }

        const maxResponseSize = options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
        const chunks = [];
        let totalSize = 0;
        let destroyed = false;
        res.on("data", (chunk) => {
          totalSize += chunk.length;
          if (totalSize > maxResponseSize) {
            destroyed = true;
            req.destroy(new Error("Response body too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (!destroyed) resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

module.exports = {
  isPrivateOrLocalHost,
  requestText,
  requestBinary,
  requestJson,
};
