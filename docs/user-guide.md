# WebControl4 — User Guide

WebControl4 is a web-based control panel for your Control4 smart home system. This guide covers everything you can do with it.

---

## Getting Started

### Connecting to Your Control4 System

1. Open WebControl4 in your browser (e.g., `http://localhost:3443`)
2. **Sign in** with your Control4 account email and password
3. The app discovers controllers on your network automatically
4. If multiple controllers are found, select the one you want to control
5. If your controller isn't discovered, you'll be prompted to enter its IP address manually

### Demo Mode

Don't have a Control4 system? Click **Try Demo Mode** on the login screen to explore all features with simulated devices.

---

## Dashboard

The dashboard has four tabs accessible from the top navigation bar:

### 🏠 Dashboard (Devices)

This is the main view showing all your devices organized by floor and room.

#### Lights

Lights are grouped by floor (Main Floor, Upper Floor, etc.) and room within each floor. Click a floor or room header to collapse/expand it.

Each light card shows:
- **Toggle switch** — tap to turn the light on or off
- **Brightness slider** — drag to set the dimming level (0–100%)

You can also:
- **Rename a light** — click the ✏️ icon on the light name
- **Rename a room** — click the ✏️ icon on the room header (updates on the controller)
- **Rename a floor** — click the ✏️ icon on the floor header (local display only)
- **Move a light to a different floor** — use the edit dialog to reassign

#### Thermostats

Each thermostat card shows:
- **Current temperature** (large number)
- **Heat setpoint** — use − / + buttons to adjust
- **Cool setpoint** — use − / + buttons to adjust
- **HVAC mode** — select Off, Heat, Cool, or Auto from the dropdown
- **Humidity** reading

#### Scenes

Scenes are built-in Control4 automations (typically for lighting). They're organized by floor and room, with whole-house scenes shown at the top.

Click **Activate** to trigger a scene. Scenes run on the controller itself.

#### Routines

Routines are custom automation sequences you create in WebControl4. Unlike scenes (which run on the controller), routines run on the server and can combine lights and thermostat commands.

Each routine card shows:
- The routine name and number of steps
- The schedule (if configured) showing time and days
- **▶ Run** — execute the routine immediately
- **Edit** — modify steps and schedule
- **Delete** — remove the routine

Click **+ New Routine** to create one (see [Creating Routines](#creating-routines) below).

---

### 📊 History

The History tab shows charts of device activity over time. Data accumulates while the dashboard is open (it's stored in server memory).

Three chart views are available:

- **Light States** — brightness levels over time for individual lights or all lights on a floor
- **Temperature** — thermostat temperature, heat setpoint, and cool setpoint over time
- **Floor Activity** — how many lights are on per floor over time

Use the dropdown selectors to choose which floor, light, or thermostat to chart.

---

### 🤖 AI Assistant

The AI assistant uses Anthropic's Claude to understand natural language commands and control your home. You must configure an Anthropic API key in Settings first.

Two modes are available:

#### 🎮 Control Devices
Type commands like:
- "Turn off all lights on the main floor"
- "Set the bedroom to 72°F"
- "Dim the kitchen to 30%"

The AI proposes a list of actions. Review them in the **Pending Actions** panel, then:
- **Execute** — run all proposed actions
- **Dismiss** — cancel without running
- **Save as Routine** — save the actions as a reusable routine

#### 📈 Analyze Trends
Ask questions about your usage:
- "Analyze my lighting patterns and suggest routines"
- "How can I save energy?"
- "Which rooms have the most activity?"

The AI uses your device history to give specific, data-driven recommendations.

---

### ⚙️ Settings

- **Anthropic API Key** — paste your API key (starts with `sk-ant-…`). The key is stored on the server and never sent to the browser.
- **Model** — choose between Claude Haiku (fast), Sonnet (balanced), or Opus (most capable)

---

## Creating Routines

1. Click **+ New Routine** on the Dashboard tab
2. Enter a **name** for the routine
3. **Add steps** — for each step:
   - Select an action type (set light level, toggle light, set HVAC mode, etc.)
   - Choose a device
   - Set the value (brightness, temperature, on/off, etc.)
   - Click **Add Step**
4. Repeat to add more steps — they execute in order with a short delay between each
5. **Set a schedule** (optional):
   - Check **Enable schedule**
   - Pick a **time** (24-hour format)
   - Select which **days of the week** the routine should run
6. Click **Save Routine**

### Editing Routines

Click **Edit** on any routine card to modify its steps, name, or schedule. You can remove individual steps with the × button.

### Scheduled Routines

When a routine has a schedule enabled, the server automatically runs it at the configured time on the selected days. The schedule appears on the routine card (e.g., "🕐 22:00 · Weekdays").

> **Note:** The server must be running for schedules to fire. If you restart the server, schedules resume automatically.

---

## Scenes vs. Routines

| Feature | Scenes | Routines |
|---------|--------|----------|
| **Where they run** | On the Control4 controller | On the WebControl4 server |
| **Device types** | Lights only (typically) | Lights + thermostats |
| **Created in** | Control4 Composer | WebControl4 UI or AI assistant |
| **Scheduling** | Via Composer | Built-in time + day scheduling |
| **Network required** | Controller must be reachable | Controller must be reachable |

---

## Tips

- **Refresh Devices** — click the refresh button at the top of the Dashboard tab to reload device state from the controller
- **Keyboard shortcut** — press Enter (without Shift) in the AI input to send your message
- The dashboard polls device state every 10 seconds and records history every 60 seconds automatically
- Floor and room renames persist in your browser's local storage
- Light name changes are saved both locally and on the controller
