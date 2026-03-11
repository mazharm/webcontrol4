# WebControl4 — Deployment Guide

This guide walks you through setting up WebControl4 on your network. It covers installation, configuration options, HTTPS, authentication, MCP server setup, and troubleshooting.

---

## Prerequisites

- **Node.js** 18 or later (Node 20+ recommended)
- **npm** (bundled with Node.js)
- A **Control4** system on the same LAN, or use demo mode to explore the interface
- (Optional) **openssl** — for auto-generating self-signed TLS certificates
- (Optional) A **Google Cloud** project with OAuth credentials — for Google sign-in

---

## Installation

```bash
git clone https://github.com/mazharm/webcontrol4.git
cd webcontrol4
npm install
```

### Quick start (demo mode)

```bash
npm start
```

Open `http://localhost:3443` and click **Try Demo Mode**. No Control4 hardware required.

---

## Configuration

All configuration is done through environment variables. Copy the example file:

```bash
cp .env.example .env
```

### Server Port

```env
PORT=3443
```

### HTTPS

Enable HTTPS for secure remote access:

```env
HTTPS_ENABLED=true
HTTPS_PORT=3443
```

**Certificate options:**

| Option | How to use |
|--------|-----------|
| Auto self-signed | Leave `TLS_CERT_FILE` and `TLS_KEY_FILE` empty. Requires `openssl` installed. |
| Your own certs | Set `TLS_CERT_FILE=/path/to/fullchain.pem` and `TLS_KEY_FILE=/path/to/privkey.pem` |
| DuckDNS + Let's Encrypt | Set `PUBLIC_HOSTNAME`, `DUCKDNS_DOMAIN`, `DUCKDNS_TOKEN`, `ACME_EMAIL`, then run `npm run cert:issue` |

When HTTPS is enabled, WebControl4 listens only on the HTTPS port.

### Google OAuth

Require Google sign-in for web access and MCP clients:

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add authorized redirect URIs:
   - `https://localhost:3443/auth/google/callback` (dev)
   - `https://your-domain:3443/auth/google/callback` (production)
4. Configure in `.env`:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
ALLOWED_EMAILS=you@gmail.com,family@gmail.com
```

Leave `ALLOWED_EMAILS` empty to allow any Google account.

---

## Running in Production

### systemd service (Linux)

Create `/etc/systemd/system/webcontrol4.service`:

```ini
[Unit]
Description=WebControl4
After=network.target

[Service]
Type=simple
User=webcontrol4
WorkingDirectory=/opt/webcontrol4
ExecStart=/usr/bin/node server.js
Restart=always
EnvironmentFile=/opt/webcontrol4/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable webcontrol4
sudo systemctl start webcontrol4
```

### PM2 (cross-platform)

```bash
npm install -g pm2
pm2 start server.js --name webcontrol4
pm2 save
pm2 startup
```

### Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3443
CMD ["node", "server.js"]
```

---

## Remote Access

To access WebControl4 from outside your LAN:

1. **Enable HTTPS** (see above) — credentials must not travel in the clear
2. **Enable Google OAuth** — to restrict who can access the app
3. **Port forward** your router's external port to the server's HTTPS port (e.g., external `443` → internal `192.168.1.x:3443`)
4. (Optional) Set up **dynamic DNS** for a stable hostname

---

## MCP Server Setup

WebControl4 includes an MCP (Model Context Protocol) server so AI assistants like Claude can control your home. Two transports are available:

### STDIO transport (Claude Desktop)

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "webcontrol4": {
      "command": "node",
      "args": ["/path/to/webcontrol4/mcp-stdio.js"],
      "env": {
        "MCP_BASE_URL": "https://localhost:3443",
        "MCP_CONTROLLER_IP": "192.168.1.100",
        "MCP_DIRECTOR_TOKEN": "your-token"
      }
    }
  }
}
```

In demo mode, omit `MCP_CONTROLLER_IP` and `MCP_DIRECTOR_TOKEN` — the server auto-authenticates.

### HTTP transport (remote AI clients)

```bash
node mcp-http.js
```

The MCP HTTP server runs on port 3001 (configurable via `MCP_HTTP_PORT`). The endpoint is `POST /mcp`.

When Google OAuth is configured, MCP clients must authenticate via OAuth 2.0:

1. Discover the authorization server: `GET /.well-known/oauth-authorization-server`
2. Register dynamically: `POST /register`
3. Authorize via the Google login flow
4. Exchange the auth code for a bearer token at `POST /token`
5. Include `Authorization: Bearer <token>` on `POST /mcp` requests

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_HTTP_PORT` | `3001` | HTTP transport port |
| `MCP_CONTROLLER_IP` | `mock` | Director IP (`mock` for demo) |
| `MCP_DIRECTOR_TOKEN` | (auto) | Director bearer token |
| `MCP_BASE_URL` | auto | Express server URL |

---

## Data & Persistence

| File | Contents |
|------|----------|
| `data/settings.json` | Anthropic API key (encrypted at rest is your responsibility), selected model |
| `data/routines.json` | Saved routines with steps and schedules |
| `certs/` | Auto-generated TLS certificates (if using self-signed) |

History data (light states, thermostat readings) is stored **in memory only** and lost on restart. It accumulates while the dashboard is open.

---

## Troubleshooting

### "No controllers found on network"

- Ensure the server is on the same subnet as the Control4 controller
- SDDP discovery uses multicast (UDP 239.255.255.250:1902) — check firewall rules
- You can always enter the controller's IP address manually

### "Failed to get director token"

- Verify your Control4 credentials are correct
- Account tokens expire — try logging in again
- Check the controller is online and reachable

### Self-signed certificate warnings

- Expected behavior when using auto-generated certs
- Either accept the warning in your browser, or provide proper certificates via `TLS_CERT_FILE`/`TLS_KEY_FILE`

### OAuth: "Email not authorized"

- Add the email to `ALLOWED_EMAILS` in `.env` and restart
- Leave `ALLOWED_EMAILS` empty to allow all Google accounts

### Scheduled routines not running

- The server must be running continuously — schedules are checked every 15 seconds
- A web client must have connected at least once to establish the director connection (the scheduler uses the last-known director IP and token)
- In mock/demo mode, schedules work immediately without a web connection
- Check server logs for `[Scheduler]` messages
