# WebControl4

A simple web client for controlling Control4 lights and thermostats from any browser.

## Features

- **Control4 account login** - authenticates via the Control4 cloud API to obtain a director bearer token
- **Controller discovery** - lists controllers registered to your account; also supports SDDP network discovery
- **Direct connection** - connect directly with a controller IP and bearer token (no cloud auth needed)
- **Light control** - toggle on/off and adjust dimmer levels (0-100%) for all lights
- **Thermostat control** - view current temperature, adjust heat/cool setpoints, and change HVAC mode

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser.

## How It Works

The server proxies requests between the browser and your local Control4 Director's REST API (HTTPS with self-signed cert). Authentication goes through Control4's cloud API to get a bearer token, then all device commands hit the controller directly on your LAN.

### Architecture

```
Browser  <-->  Express server (:3000)  <-->  Control4 Director (https://<IP>)
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

Set the port with the `PORT` environment variable (default: 3000):

```bash
PORT=8080 npm start
```

## License

MIT
