// ---------------------------------------------------------------------------
// device-map.test.js — the MQTT bridge must produce the same device state the
// local REST/SSE path produces, because the React client renders both through
// the identical UnifiedDevice types.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { buildDeviceState, deviceToMqttPayload } = require(
  path.resolve(__dirname, "..", "mqtt", "device-map.js")
);

function light(variables) {
  return buildDeviceState({ type: "light", variables });
}

function thermostat(variables) {
  return buildDeviceState({ type: "thermostat", variables });
}

// --- lights -----------------------------------------------------------------

test("dimmer level drives on/off", () => {
  assert.equal(light({ LIGHT_LEVEL: "75" }).on, true);
  assert.equal(light({ LIGHT_LEVEL: "75" }).level, 75);
  assert.equal(light({ LIGHT_LEVEL: "0" }).on, false);
});

test("non-dimming switch is ON via LIGHT_STATE without LIGHT_LEVEL", () => {
  // state-machine._isLightOn and client mapC4Light both honour LIGHT_STATE.
  // Deriving `on` from level alone reported these switches as OFF over MQTT.
  for (const value of ["1", 1, "true", "on", "On", true]) {
    const state = light({ LIGHT_STATE: value });
    assert.equal(state.on, true, `LIGHT_STATE=${String(value)} should be on`);
  }
});

test("LIGHT_STATE off values keep the light off", () => {
  for (const value of ["0", 0, "false", "off", undefined]) {
    assert.equal(light({ LIGHT_STATE: value }).on, false, `LIGHT_STATE=${String(value)}`);
  }
});

test("light level is clamped to 0..100 and defaults to 0", () => {
  assert.equal(light({ LIGHT_LEVEL: "250" }).level, 100);
  assert.equal(light({ LIGHT_LEVEL: "-5" }).level, 0);
  assert.equal(light({ LIGHT_LEVEL: "bogus" }).level, 0);
  assert.equal(light({}).level, 0);
});

// --- thermostats ------------------------------------------------------------

test("missing temperature is null, not 0", () => {
  // UnifiedDevice.currentTempF is `number | null`; the UI renders "--" only
  // for null, so 0 surfaced as a bogus 0°F reading in remote mode.
  assert.equal(thermostat({}).currentTempF, null);
  assert.equal(thermostat({ TEMPERATURE_F: "" }).currentTempF, null);
  assert.equal(thermostat({ TEMPERATURE_F: "n/a" }).currentTempF, null);
});

test("real temperature readings are preserved, including 0", () => {
  assert.equal(thermostat({ TEMPERATURE_F: "68.5" }).currentTempF, 68.5);
  assert.equal(thermostat({ TEMPERATURE_F: "0" }).currentTempF, 0);
  assert.equal(thermostat({ TEMPERATURE_F: "-4" }).currentTempF, -4);
});

test("thermostat setpoints fall back to defaults", () => {
  const state = thermostat({});
  assert.equal(state.heatSetpointF, 68);
  assert.equal(state.coolSetpointF, 74);
  assert.equal(state.hvacMode, "Off");
});

// --- payload shape ----------------------------------------------------------

test("deviceToMqttPayload keeps the control4: id prefix and state", () => {
  const payload = deviceToMqttPayload({
    itemId: 42,
    type: "light",
    name: "Kitchen",
    room: "Kitchen",
    roomId: 7,
    floor: "Main",
    variables: { LIGHT_STATE: "1" },
  });
  assert.equal(payload.id, "control4:42");
  assert.equal(payload.source, "control4");
  assert.equal(payload.roomId, 7);
  assert.equal(payload.state.on, true);
});
