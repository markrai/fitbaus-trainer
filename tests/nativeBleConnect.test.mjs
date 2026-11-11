import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { CCCD_UUID } from "../dist/platform/bleCharacteristicReady.js";
import {
  connectNativeBle,
  resetNativeBleForTests,
} from "../dist/platform/nativeBle.js";

const HR_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb";
const HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb";

afterEach(() => {
  resetNativeBleForTests();
});

function createClock() {
  let now = 0;
  return {
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
}

function hrReadyServices() {
  return [
    {
      uuid: HR_SERVICE,
      characteristics: [
        {
          uuid: HR_MEASUREMENT,
          descriptors: [{ uuid: CCCD_UUID }],
        },
      ],
    },
  ];
}

function createHandlers() {
  const events = [];
  return {
    events,
    handlers: {
      onConnected(name) {
        events.push({ type: "onConnected", name });
      },
      onDisconnected() {
        events.push({ type: "onDisconnected" });
      },
      onBpm() {},
      onBattery() {},
    },
  };
}

function createFakeClient(overrides = {}) {
  const state = {
    getServicesCalls: 0,
    startCalls: 0,
    connectCalls: 0,
    disconnectCalls: 0,
    servicesProvider: () => hrReadyServices(),
    startNotificationsImpl: async () => {},
    ...overrides,
  };

  const client = {
    async initialize() {},
    async requestDevice() {
      return { deviceId: "magene-h613", name: "Magene H613" };
    },
    async connect() {
      state.connectCalls += 1;
    },
    async disconnect() {
      state.disconnectCalls += 1;
    },
    async getServices() {
      state.getServicesCalls += 1;
      return state.servicesProvider(state.getServicesCalls);
    },
    async discoverServices() {},
    async startNotifications(deviceId, service, characteristic, callback) {
      state.startCalls += 1;
      return state.startNotificationsImpl(deviceId, service, characteristic, callback, state);
    },
    async stopNotifications() {},
    async read() {
      throw new Error("no battery");
    },
  };

  return { client, state };
}

test("connectNativeBle emits onConnected only after notification subscription succeeds", async () => {
  const clock = createClock();
  const order = [];
  const { handlers, events } = createHandlers();
  const { client, state } = createFakeClient({
    servicesProvider: (n) => (n < 2 ? [] : hrReadyServices()),
    startNotificationsImpl: async () => {
      order.push("startNotifications");
    },
  });
  const originalOnConnected = handlers.onConnected;
  handlers.onConnected = (name) => {
    order.push("onConnected");
    originalOnConnected(name);
  };

  await connectNativeBle(handlers, {
    client,
    readinessOptions: {
      timeoutMs: 2000,
      pollIntervalMs: 25,
      rediscoveryAfterMs: 1500,
      now: clock.now,
      sleep: clock.sleep,
    },
  });

  assert.deepEqual(order, ["startNotifications", "onConnected"]);
  assert.deepEqual(events, [{ type: "onConnected", name: "Magene H613" }]);
  assert.equal(state.startCalls, 1);
  assert.equal(state.connectCalls, 1);
});

test("connectNativeBle never emits onConnected when readiness times out", async () => {
  const clock = createClock();
  const { handlers, events } = createHandlers();
  const { client, state } = createFakeClient({
    servicesProvider: () => [],
  });

  await assert.rejects(
    () =>
      connectNativeBle(handlers, {
        client,
        readinessOptions: {
          timeoutMs: 200,
          pollIntervalMs: 40,
          rediscoveryAfterMs: 80,
          maxDiscoverAttempts: 1,
          now: clock.now,
          sleep: clock.sleep,
        },
      }),
    /not available after 200ms/
  );

  assert.deepEqual(events, [{ type: "onDisconnected" }]);
  assert.equal(state.startCalls, 0);
  assert.ok(state.disconnectCalls >= 1);
});

test("connectNativeBle never emits onConnected when startNotifications fails", async () => {
  const clock = createClock();
  const { handlers, events } = createHandlers();
  const { client, state } = createFakeClient({
    startNotificationsImpl: async () => {
      throw new Error("Setting notification failed.");
    },
  });

  await assert.rejects(
    () =>
      connectNativeBle(handlers, {
        client,
        readinessOptions: {
          timeoutMs: 1000,
          now: clock.now,
          sleep: clock.sleep,
        },
      }),
    /Setting notification failed/
  );

  assert.deepEqual(events, [{ type: "onDisconnected" }]);
  assert.equal(state.startCalls, 1);
  assert.ok(state.disconnectCalls >= 1);
});

test("connectNativeBle never emits onConnected when CCCD never becomes ready", async () => {
  const clock = createClock();
  const { handlers, events } = createHandlers();
  const { client, state } = createFakeClient({
    servicesProvider: () => [
      {
        uuid: HR_SERVICE,
        characteristics: [{ uuid: HR_MEASUREMENT, descriptors: [] }],
      },
    ],
  });

  await assert.rejects(
    () =>
      connectNativeBle(handlers, {
        client,
        readinessOptions: {
          timeoutMs: 200,
          pollIntervalMs: 40,
          rediscoveryAfterMs: 80,
          maxDiscoverAttempts: 1,
          now: clock.now,
          sleep: clock.sleep,
        },
      }),
    /not available after 200ms/
  );

  assert.deepEqual(events, [{ type: "onDisconnected" }]);
  assert.equal(state.startCalls, 0);
});
