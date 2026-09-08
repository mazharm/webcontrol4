const test = require("node:test");
const assert = require("node:assert/strict");

const mqttClient = require("../mqtt/mqtt-client");

test("deviceCommand RPC invokes the command handler once across QoS redelivery", async () => {
  let requestHandler;
  const published = [];
  const originalSubscribe = mqttClient.subscribe;
  const originalPublish = mqttClient.publish;
  const originalGetHomeId = mqttClient.getHomeId;

  mqttClient.subscribe = (_topic, handler) => { requestHandler = handler; };
  mqttClient.publish = (topic, payload) => {
    published.push({ topic, payload });
    return true;
  };
  mqttClient.getHomeId = () => "test-home";

  const rpcPath = require.resolve("../mqtt/rpc-handler");
  delete require.cache[rpcPath];
  const rpcHandler = require(rpcPath);
  const calls = [];
  rpcHandler.init({
    ring: {},
    executeDeviceCommand: async (...args) => { calls.push(args); },
  });

  try {
    const request = {
      id: "request-1",
      method: "deviceCommand",
      params: {
        system: "control4",
        deviceId: "42",
        command: { level: 75 },
      },
      ts: new Date().toISOString(),
    };
    await requestHandler(request, "wc4/test-home/rpc/request");
    await requestHandler(request, "wc4/test-home/rpc/request");

    assert.deepEqual(calls, [["control4", "42", { level: 75 }]]);
    assert.deepEqual(published, [
      {
        topic: "wc4/test-home/rpc/response/request-1",
        payload: { id: "request-1", result: { success: true } },
      },
      {
        topic: "wc4/test-home/rpc/response/request-1",
        payload: { id: "request-1", result: { success: true } },
      },
    ]);
  } finally {
    mqttClient.subscribe = originalSubscribe;
    mqttClient.publish = originalPublish;
    mqttClient.getHomeId = originalGetHomeId;
    delete require.cache[rpcPath];
  }
});
