const test = require("node:test");
const assert = require("node:assert/strict");

const { StateMachine } = require("../state-machine");

function makeDevice(overrides = {}) {
  return {
    itemId: 1,
    name: "Test Light",
    type: "light",
    room: "Test Room",
    roomId: 1,
    floor: "Main",
    variables: Object.create(null),
    variableTimestamps: Object.create(null),
    lastChanged: null,
    lastChangedVariable: null,
    previousValue: null,
    changeCount: 0,
    lastReadAt: null,
    ...overrides,
  };
}

test("a catch-up read cannot overwrite a newer websocket event", async () => {
  let releaseRead;
  const readResult = new Promise((resolve) => { releaseRead = resolve; });
  const state = new StateMachine({ apiFn: () => readResult });
  const device = makeDevice();
  state._devices.set(device.itemId, device);

  const pendingRead = state.readInitialState();
  await new Promise((resolve) => setImmediate(resolve));
  state.handleDeviceEvent({ itemId: 1, varName: "LIGHT_LEVEL", value: "100" });
  releaseRead([{ varName: "LIGHT_LEVEL", value: "0" }]);
  await pendingRead;

  assert.equal(device.variables.LIGHT_LEVEL, "100");
});

test("initial observations do not immediately classify the home as away", async () => {
  const state = new StateMachine({
    apiFn: async () => [{ varName: "LIGHT_LEVEL", value: "0" }],
  });
  state._devices.set(1, makeDevice());

  await state.readInitialState();

  assert.notEqual(state.getHomeState().mode, "away");
  assert.ok(state.getHomeState().lastActivityTime);
});

test("home-state derivation is coalesced across event bursts", async () => {
  const state = new StateMachine({ apiFn: async () => [] });
  const device = makeDevice({
    variables: { LIGHT_LEVEL: "0", LIGHT_STATE: "0" },
  });
  state._devices.set(1, device);
  let homeStateChanges = 0;
  state.on("homeStateChange", () => { homeStateChanges++; });

  state.handleDeviceEvent({ itemId: 1, varName: "LIGHT_LEVEL", value: "25" });
  state.handleDeviceEvent({ itemId: 1, varName: "LIGHT_LEVEL", value: "50" });
  state.handleDeviceEvent({ itemId: 1, varName: "LIGHT_STATE", value: "1" });
  await new Promise((resolve) => setTimeout(resolve, 225));

  assert.equal(homeStateChanges, 1);
  state.destroy();
  assert.equal(state._deriveTimer, null);
  assert.equal(state._deriveRefreshTimer, null);
});
