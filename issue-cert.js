require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const acme = require("acme-client");

function required(name, value) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        resolve(body.trim());
      });
    });
    req.on("error", reject);
  });
}

async function main() {
  const publicHostname = required("PUBLIC_HOSTNAME", process.env.PUBLIC_HOSTNAME).toLowerCase();
  const duckdnsDomain = required(
    "DUCKDNS_DOMAIN",
    process.env.DUCKDNS_DOMAIN ||
      (publicHostname.endsWith(".duckdns.org")
        ? publicHostname.slice(0, -".duckdns.org".length)
        : "")
  ).toLowerCase();
  const duckdnsToken = required("DUCKDNS_TOKEN", process.env.DUCKDNS_TOKEN);
  const acmeEmail = required("ACME_EMAIL", process.env.ACME_EMAIL);

  if (!publicHostname.endsWith(".duckdns.org")) {
    throw new Error("PUBLIC_HOSTNAME must end with .duckdns.org for the DuckDNS flow");
  }

  const certFile = path.resolve(
    process.env.TLS_CERT_FILE || path.join(__dirname, "certs", "letsencrypt", "fullchain.pem")
  );
  const keyFile = path.resolve(
    process.env.TLS_KEY_FILE || path.join(__dirname, "certs", "letsencrypt", "privkey.pem")
  );
  const accountKeyFile = path.resolve(
    process.env.ACME_ACCOUNT_KEY_FILE || path.join(__dirname, "data", "acme", "account.key.pem")
  );
  const dnsDelayMs = Math.max(15000, Number(process.env.ACME_DNS_DELAY_MS) || 45000);
  const directoryUrl = process.env.ACME_DIRECTORY_URL || acme.directory.letsencrypt.production;

  async function updateDuckDns(params = {}) {
    const url = new URL("https://www.duckdns.org/update");
    url.searchParams.set("domains", duckdnsDomain);
    url.searchParams.set("token", duckdnsToken);
    url.searchParams.set("verbose", "true");
    if (params.clear) {
      url.searchParams.set("clear", "true");
    }
    if (params.txt !== undefined) {
      url.searchParams.set("txt", params.txt);
    }

    const body = await requestText(url);
    if (!body.startsWith("OK")) {
      throw new Error(`DuckDNS update failed: ${body}`);
    }
    return body;
  }

  ensureParentDir(accountKeyFile);
  const accountKey = fs.existsSync(accountKeyFile)
    ? fs.readFileSync(accountKeyFile, "utf8")
    : await acme.crypto.createPrivateRsaKey();

  if (!fs.existsSync(accountKeyFile)) {
    fs.writeFileSync(accountKeyFile, accountKey, { mode: 0o600 });
    console.log(`[cert] Created ACME account key at ${accountKeyFile}`);
  }

  console.log(`[cert] Updating DuckDNS A record for ${publicHostname}`);
  await updateDuckDns();

  const client = new acme.Client({
    directoryUrl,
    accountKey,
  });

  const [certificateKey, certificateCsr] = await acme.crypto.createCsr({
    commonName: publicHostname,
    altNames: [publicHostname],
  });

  console.log(`[cert] Requesting Let's Encrypt certificate for ${publicHostname}`);
  const certificate = await client.auto({
    csr: certificateCsr,
    email: acmeEmail,
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    skipChallengeVerification: true,
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type !== "dns-01") return;
      console.log("[cert] Setting DuckDNS TXT challenge");
      await updateDuckDns({ txt: keyAuthorization });
      console.log(`[cert] Waiting ${Math.round(dnsDelayMs / 1000)}s for DNS propagation`);
      await wait(dnsDelayMs);
    },
    challengeRemoveFn: async (_authz, challenge) => {
      if (challenge.type !== "dns-01") return;
      try {
        await updateDuckDns({ clear: true });
        console.log("[cert] Cleared DuckDNS TXT challenge");
      } catch (err) {
        console.warn(`[cert] Warning: failed to clear DuckDNS TXT record: ${err.message}`);
      }
    },
  });

  ensureParentDir(certFile);
  ensureParentDir(keyFile);
  fs.writeFileSync(certFile, certificate, { mode: 0o600 });
  fs.writeFileSync(keyFile, certificateKey, { mode: 0o600 });

  const firstCert = certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  const parsed = new crypto.X509Certificate(firstCert ? firstCert[0] : certificate);

  console.log(`[cert] Wrote certificate: ${certFile}`);
  console.log(`[cert] Wrote private key: ${keyFile}`);
  console.log(`[cert] Subject: ${parsed.subject}`);
  console.log(`[cert] Valid until: ${parsed.validTo}`);
}

main().catch((err) => {
  console.error(`[cert] Error: ${err.message}`);
  process.exitCode = 1;
});
