const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveControl4Command, isDuplicateCommand } = require("../mqtt/command-handler");

test("maps explicit lock, media, scene, and volume commands", () => {
  assert.deepEqual(resolveControl4Command({ locked: true }, "lock"), {
    command: "LOCK",
    tParams: {},
  });
  assert.deepEqual(resolveControl4Command({ power: false }, "media"), {
    command: "OFF",
    tParams: {},
  });
  assert.deepEqual(resolveControl4Command({ activate: true }, null), {
    command: "ACTIVATE",
    tParams: {},
  });
  assert.deepEqual(resolveControl4Command({ volume: 35 }, "media"), {
    command: "SET_VOLUME_LEVEL",
    tParams: { LEVEL: 35 },
  });
});

test("rejects ambiguous and device-type-incompatible commands", () => {
  assert.throws(
    () => resolveControl4Command({ on: true, power: true }, "media"),
    /exactly one supported command field/
  );
  assert.throws(
    () => resolveControl4Command({ on: true }, "lock"),
    /not valid for Control4 device type lock/
  );
});

test("allows valid commands while device discovery is incomplete", () => {
  assert.deepEqual(resolveControl4Command({ locked: false }, null), {
    command: "UNLOCK",
    tParams: {},
  });
});

test("suppresses duplicate QoS command deliveries", () => {
  const topic = "wc4/home/cmd/routines/night/execute";
  const payload = { ts: "2026-09-07T12:00:00.000Z" };
  assert.equal(isDuplicateCommand(topic, payload), false);
  assert.equal(isDuplicateCommand(topic, payload), true);
});
