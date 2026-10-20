import assert from "node:assert/strict";
import test from "node:test";
import {
  CCCD_UUID,
  isCharacteristicNotFoundError,
  normalizeBleUuid,
  servicesIncludeCharacteristic,
  servicesIncludeNotificationTarget,
  startNotificationsWhenReady,
  waitForBleCharacteristic,
} from "../dist/platform/bleCharacteristicReady.js";

const HR_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb";
const HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb";

function hrServicesReady() {
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

function hrServicesCharOnlyNoDescriptorsKey() {
  return [
    {
      uuid: HR_SERVICE,
      characteristics: [{ uuid: HR_MEASUREMENT }],
    },
  ];
}

function hrServicesMissingCccd() {
  return [
    {
      uuid: HR_SERVICE,
      characteristics: [
        {
          uuid: HR_MEASUREMENT,
          descriptors: [],
        },
      ],
    },
  ];
}

function emptyServices() {
  return [];
}

function otherServices() {
  return [
    {
      uuid: "0000180f-0000-1000-8000-00805f9b34fb",
      characteristics: [
        {
          uuid: "00002a19-0000-1000-8000-00805f9b34fb",
          descriptors: [],
        },
      ],
    },
  ];
}

function createClock() {
  let now = 0;
  const sleeps = [];
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

test("normalizeBleUuid lowercases and trims", () => {
  assert.equal(normalizeBleUuid("  0000180D-0000-1000-8000-00805F9B34FB "), HR_SERVICE);
});

test("servicesIncludeNotificationTarget requires CCCD when descriptors are exposed", () => {
  assert.equal(
    servicesIncludeNotificationTarget(hrServicesReady(), HR_SERVICE, HR_MEASUREMENT),
    true
  );
  assert.equal(
    servicesIncludeNotificationTarget(hrServicesMissingCccd(), HR_SERVICE, HR_MEASUREMENT),
    false
  );
  assert.equal(
    servicesIncludeNotificationTarget(
      [
        {
          uuid: "0000180D-0000-1000-8000-00805F9B34FB",
          characteristics: [
            {
              uuid: "00002A37-0000-1000-8000-00805F9B34FB",
              descriptors: [{ uuid: "00002902-0000-1000-8000-00805F9B34FB" }],
            },
          ],
        },
      ],
      HR_SERVICE,
      HR_MEASUREMENT
    ),
    true
  );
});

test("servicesIncludeNotificationTarget accepts characteristic when descriptors are omitted", () => {
  assert.equal(
    servicesIncludeNotificationTarget(
      hrServicesCharOnlyNoDescriptorsKey(),
      HR_SERVICE,
      HR_MEASUREMENT
    ),
    true
  );
});

test("servicesIncludeCharacteristic still matches characteristic without CCCD check", () => {
  assert.equal(servicesIncludeCharacteristic(hrServicesMissingCccd(), HR_SERVICE, HR_MEASUREMENT), true);
  assert.equal(servicesIncludeCharacteristic(otherServices(), HR_SERVICE, HR_MEASUREMENT), false);
  assert.equal(servicesIncludeCharacteristic(emptyServices(), HR_SERVICE, HR_MEASUREMENT), false);
});

test("isCharacteristicNotFoundError detects plugin rejection text", () => {
  assert.equal(isCharacteristicNotFoundError(new Error("Characteristic not found.")), true);
  assert.equal(isCharacteristicNotFoundError("Characteristic not found"), true);
  assert.equal(isCharacteristicNotFoundError(new Error("Connection timeout.")), false);
  assert.equal(isCharacteristicNotFoundError(new Error("Setting notification failed.")), false);
});

test("waitForBleCharacteristic polls in-flight discovery before rediscovering", async () => {
  const clock = createClock();
  let getServicesCalls = 0;
  let discoverCalls = 0;
  const client = {
    async getServices() {
      getServicesCalls += 1;
      // Ready after a few polls, still before rediscoveryAfterMs.
      return getServicesCalls < 3 ? emptyServices() : hrServicesReady();
    },
    async discoverServices() {
      discoverCalls += 1;
    },
  };

  await waitForBleCharacteristic(client, "device-1", HR_SERVICE, HR_MEASUREMENT, {
    timeoutMs: 5000,
    pollIntervalMs: 50,
    rediscoveryAfterMs: 1000,
    maxDiscoverAttempts: 2,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.ok(getServicesCalls >= 3);
  assert.equal(discoverCalls, 0, "must not rediscover while in-flight discovery can still populate GATT");
  assert.ok(clock.now() < 1000);
});

test("waitForBleCharacteristic waits for CCCD after characteristic appears", async () => {
  const clock = createClock();
  let getServicesCalls = 0;
  const client = {
    async getServices() {
      getServicesCalls += 1;
      if (getServicesCalls < 2) return emptyServices();
      if (getServicesCalls < 4) return hrServicesMissingCccd();
      return hrServicesReady();
    },
    async discoverServices() {
      throw new Error("should not rediscover yet");
    },
  };

  await waitForBleCharacteristic(client, "device-1", HR_SERVICE, HR_MEASUREMENT, {
    timeoutMs: 2000,
    pollIntervalMs: 40,
    rediscoveryAfterMs: 1500,
    maxDiscoverAttempts: 1,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.ok(getServicesCalls >= 4);
});

test("waitForBleCharacteristic uses bounded rediscovery only after poll window", async () => {
  const clock = createClock();
  let getServicesCalls = 0;
  let discoverCalls = 0;
  const client = {
    async getServices() {
      getServicesCalls += 1;
      return discoverCalls >= 1 ? hrServicesReady() : emptyServices();
    },
    async discoverServices() {
      discoverCalls += 1;
    },
  };

  await waitForBleCharacteristic(client, "device-1", HR_SERVICE, HR_MEASUREMENT, {
    timeoutMs: 3000,
    pollIntervalMs: 100,
    rediscoveryAfterMs: 500,
    maxDiscoverAttempts: 1,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(discoverCalls, 1);
  assert.ok(clock.now() >= 500);
  assert.ok(getServicesCalls >= 2);
});

test("waitForBleCharacteristic fails cleanly when characteristic never appears", async () => {
  const clock = createClock();
  let getServicesCalls = 0;
  const client = {
    async getServices() {
      getServicesCalls += 1;
      return otherServices();
    },
    async discoverServices() {},
  };

  await assert.rejects(
    () =>
      waitForBleCharacteristic(client, "device-1", HR_SERVICE, HR_MEASUREMENT, {
        timeoutMs: 250,
        pollIntervalMs: 50,
        rediscoveryAfterMs: 100,
        maxDiscoverAttempts: 1,
        now: clock.now,
        sleep: clock.sleep,
      }),
    /not available after 250ms/
  );
  assert.ok(getServicesCalls >= 2);
});

test("waitForBleCharacteristic fails when CCCD never appears", async () => {
  const clock = createClock();
  const client = {
    async getServices() {
      return hrServicesMissingCccd();
    },
    async discoverServices() {},
  };

  await assert.rejects(
    () =>
      waitForBleCharacteristic(client, "device-1", HR_SERVICE, HR_MEASUREMENT, {
        timeoutMs: 200,
        pollIntervalMs: 40,
        rediscoveryAfterMs: 80,
        maxDiscoverAttempts: 1,
        now: clock.now,
        sleep: clock.sleep,
      }),
    /not available after 200ms/
  );
});

test("startNotificationsWhenReady retries Characteristic not found until GATT is ready", async () => {
  const clock = createClock();
  let getServicesCalls = 0;
  let startCalls = 0;
  const notifications = [];

  const client = {
    async getServices() {
      getServicesCalls += 1;
      return getServicesCalls === 1 ? emptyServices() : hrServicesReady();
    },
    async discoverServices() {},
    async startNotifications(deviceId, service, characteristic, callback) {
      startCalls += 1;
      if (startCalls === 1) {
        throw new Error("Characteristic not found.");
      }
      notifications.push({ deviceId, service, characteristic, callback });
    },
  };

  const onNotify = () => {};
  await startNotificationsWhenReady(client, "device-1", HR_SERVICE, HR_MEASUREMENT, onNotify, {
    timeoutMs: 2000,
    pollIntervalMs: 20,
    notificationRetryDelayMs: 10,
    rediscoveryAfterMs: 1500,
    maxNotificationAttempts: 5,
    maxDiscoverAttempts: 1,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(startCalls, 2);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].callback, onNotify);
});

test("startNotificationsWhenReady does not retry Setting notification failed", async () => {
  const clock = createClock();
  let startCalls = 0;
  const client = {
    async getServices() {
      return hrServicesReady();
    },
    async discoverServices() {},
    async startNotifications() {
      startCalls += 1;
      throw new Error("Setting notification failed.");
    },
  };

  await assert.rejects(
    () =>
      startNotificationsWhenReady(client, "device-1", HR_SERVICE, HR_MEASUREMENT, () => {}, {
        timeoutMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    /Setting notification failed/
  );
  assert.equal(startCalls, 1);
});

test("startNotificationsWhenReady fails cleanly when characteristic is genuinely missing", async () => {
  const clock = createClock();
  let startCalls = 0;
  const client = {
    async getServices() {
      return otherServices();
    },
    async discoverServices() {},
    async startNotifications() {
      startCalls += 1;
      throw new Error("Characteristic not found.");
    },
  };

  await assert.rejects(
    () =>
      startNotificationsWhenReady(client, "device-1", HR_SERVICE, HR_MEASUREMENT, () => {}, {
        timeoutMs: 200,
        pollIntervalMs: 40,
        rediscoveryAfterMs: 80,
        maxDiscoverAttempts: 1,
        maxNotificationAttempts: 3,
        now: clock.now,
        sleep: clock.sleep,
      }),
    /not available after 200ms/
  );
  assert.equal(startCalls, 0, "must not call startNotifications before characteristic is confirmed");
});
