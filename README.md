# WebControl4

A simple web client for controlling Control4 lights and thermostats from any browser.

## Features

- **Control4 account login** - authenticates via the Control4 cloud API to obtain a director bearer token
- **Controller discovery** - lists controllers registered to your account; also supports SDDP network discovery
- **Direct connection** - connect directly with a controller IP and bearer token (no cloud auth needed)
- **Light control** - toggle on/off and adjust dimmer levels (0-100%) for all lights
- **Thermostat control** - view current temperature, adjust heat/cool setpoints, and change HVAC mode
- **Scenes** - activate Control4 scenes from the web UI
- **Routines** - create multi-step automations combining lights and thermostats
- **Scheduled routines** - run routines automatically at specific times and days of the week
- **AI assistant** - control devices and analyze usage patterns via natural language (Anthropic Claude)
- **Device history** - charts showing light states, temperature, and floor activity over time
- **MCP server** - AI assistant integration via Model Context Protocol (STDIO and HTTP transports)

## Documentation

| Guide | Audience |
|-------|----------|
| [Deployment Guide](docs/deployment.md) | System administrators setting up WebControl4 |
| [User Guide](docs/user-guide.md) | End users controlling their smart home |
| [Design Documentation](docs/design.md) | Developers contributing to the codebase |

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3443 in your browser.

## How It Works

The server proxies requests between the browser and your local Control4 Director's REST API (HTTPS with self-signed cert). Authentication goes through Control4's cloud API to get a bearer token, then all device commands hit the controller directly on your LAN.

### Architecture

```
Browser  <-->  Express server (:3443)  <-->  Control4 Director (https://<IP>)
                     |
                     +--> Control4 Cloud API (authentication only)
```

### Control4 Director REST API

The app uses these Director endpoints:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/categories/lights` | List all lights |
| GET | `/api/v1/categories/thermostats` | List all thermostats |
| GET | `/api/v1/items/{id}/variables?varnames=...` | Read device state |
| POST | `/api/v1/items/{id}/commands` | Send commands (SET_LEVEL, SET_SETPOINT_HEAT, etc.) |

## Configuration

Copy `.env.example` to `.env` and edit as needed. All settings are optional — without a `.env` file, the server serves plain HTTP on port 3443 with no auth.

```bash
cp .env.example .env
```

Set the port with the `PORT` environment variable when running without HTTPS (default: 3443):

```bash
PORT=8080 npm start
```

## Remote Access

To access WebControl4 from outside your LAN you need two things: HTTPS (so credentials aren't sent in the clear) and authentication (so only you can use it).

### Basic Auth

Set `AUTH_USERNAME` and `AUTH_PASSWORD` in `.env`. The browser will show its native login dialog when you first connect.

```env
AUTH_USERNAME=admin
AUTH_PASSWORD=your-secret-password
```

### HTTPS

Set `HTTPS_ENABLED=true` in `.env`. The server will listen on port 3443 (configurable via `HTTPS_PORT`) and will not open a separate HTTP port.

```env
HTTPS_ENABLED=true
```

**Certificate options:**

1. **Auto-generated self-signed cert** (default) — if `TLS_CERT_FILE` and `TLS_KEY_FILE` are not set, the server runs `openssl` to generate a self-signed certificate in `certs/`. Your browser will show a security warning you can accept.

2. **Your own certificates** — point to PEM files:
   ```env
   TLS_CERT_FILE=/path/to/fullchain.pem
   TLS_KEY_FILE=/path/to/privkey.pem
   ```

3. **DuckDNS + Let's Encrypt** — set `PUBLIC_HOSTNAME`, `DUCKDNS_DOMAIN`, `DUCKDNS_TOKEN`, and `ACME_EMAIL`, point `TLS_CERT_FILE` / `TLS_KEY_FILE` at your desired output files, then run:
   ```bash
   npm run cert:issue
   ```

### Port Forwarding

Forward your router's external port to the server's HTTPS port (default 3443). For example, forward external port 443 to internal `<server-ip>:3443`. Then access the app at `https://<your-public-ip>` or set up a dynamic DNS hostname.

## License

MIT
