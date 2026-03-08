const http = require("http");
const https = require("https");

function isPrivateOrLocalHost(hostname) {
  if (!hostname) return false;

  const normalized = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;

  const parts = normalized.split(".");
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^\d+$/.test(p) || (p.length > 1 && p.startsWith("0")) || Number(p) > 255)
  ) {
    return false;
  }

  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

function filterRedirectHeaders(headers, fromUrl, toUrl) {
  if (fromUrl.origin === toUrl.origin) {
    return { ...headers };
  }

  const filtered = { ...headers };
  delete filtered.Authorization;
  delete filtered.authorization;
  delete filtered.Cookie;
  delete filtered.cookie;
  delete filtered["x-api-key"];
  delete filtered["X-API-Key"];
  delete filtered["Proxy-Authorization"];
  delete filtered["proxy-authorization"];
  return filtered;
}

function requestText(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error("Too many redirects"));
    }

    const parsed = new URL(url);
    const headers = { ...(options.headers || {}) };
    const bodyBuf =
      typeof options.body === "string" || Buffer.isBuffer(options.body)
        ? Buffer.from(options.body)
        : null;

    if (bodyBuf) {
      headers["Content-Length"] = bodyBuf.length;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      parsed,
      {
        method: options.method || "GET",
        headers,
        timeout: options.timeout || 30000,
        rejectUnauthorized: parsed.protocol === "https:" ? !isPrivateOrLocalHost(parsed.hostname) : undefined,
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, parsed);
          res.resume();
          return resolve(
            requestText(
              redirectUrl.href,
              {
                ...options,
                headers: filterRedirectHeaders(headers, parsed, redirectUrl),
              },
              redirectCount + 1
            )
          );
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body }));
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

module.exports = {
  isPrivateOrLocalHost,
  requestText,
  requestJson,
};
