import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import * as workoutStorage from "../dist/workoutStorage.js";
import { openCurrentDatabase } from "../dist/persistence/indexedDb.js";
import {
  getWorkoutRowsBySessionId,
  putWorkoutRow,
  readWorkoutRowsNewestFirst,
} from "../dist/persistence/repositories/workoutsRepository.js";
import {
  addHrSampleIfAbsent,
  deleteHrSampleRowsForSession,
  getHrSampleRows,
} from "../dist/persistence/repositories/hrSamplesRepository.js";
import {
  findTelemetrySessionIdsObservedBefore,
  getOrdinaryBikeTelemetryRows,
  writeOrdinaryBikeTelemetrySample,
} from "../dist/persistence/repositories/ordinaryBikeTelemetryRepository.js";
import {
  deleteSisuSettingsRow,
  getSisuSettingsRow,
  putSisuSettingsRow,
} from "../dist/persistence/repositories/sisuSettingsRepository.js";
import { buildOrdinaryBikeTelemetrySample } from "../dist/ordinaryWorkoutTelemetry.js";

globalThis.IDBKeyRange = IDBKeyRange;

/** Each test gets a fresh database and no cached connection. */
async function freshDatabase() {
  globalThis.indexedDB = new IDBFactory();
  await workoutStorage.resetWorkoutStorageForTests();
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const metric = (value) => ({ current: true, value });
function telemetrySample({ session = "w1", sec, at = T0 + sec * 1000, fresh = true, snapshot }) {
  const sample = buildOrdinaryBikeTelemetrySample({
    athleteId: "a1",
    sessionId: session,
    activeSec: sec,
    observedAtMs: at,
    telemetryStale: false,
    telemetryReceivedAtMs: fresh ? at - 100 : null,
    telemetrySnapshotAt: fresh ? (snapshot ?? `snap-${session}-${sec}`) : null,
    watts: metric(100),
    cadenceRpm: metric(80),
    observedResistance: metric(5),
  });
  assert.ok(sample, "fixture sample must be valid");
  return sample;
}

test("workoutStorage facade runtime export surface is unchanged", () => {
  const surface = Object.fromEntries(Object.keys(workoutStorage).sort().map((name) => [name, typeof workoutStorage[name]]));
  assert.deepEqual(surface, {
    ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS: "number",
    STORE_ORDINARY_BIKE_TELEMETRY: "string",
    cleanupAbandonedOrdinaryBikeTelemetry: "function",
    clearHrSamples: "function",
    clearOrdinaryBikeTelemetry: "function",
    clearSisuSettings: "function",
    deleteWorkoutSummary: "function",
    flushOrdinaryBikeTelemetryWrites: "function",
    getAllWorkoutSummaries: "function",
    getHrSamples: "function",
    getOrdinaryBikeTelemetrySamples: "function",
    getSisuSettings: "function",
    initDB: "function",
    queueOrdinaryBikeTelemetrySample: "function",
    registerStorageGlobals: "function",
    resetWorkoutStorageForTests: "function",
    storeHrSample: "function",
    storeOrdinaryBikeTelemetrySample: "function",
    storeSisuSettings: "function",
    storeWorkoutSummary: "function",
  });
  assert.equal(workoutStorage.STORE_ORDINARY_BIKE_TELEMETRY, "ordinary_bike_telemetry");
  assert.equal(workoutStorage.ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS, 48 * 60 * 60 * 1000);
});

test("one cached application connection is shared by the facade and repositories", async () => {
  await freshDatabase();
  const first = await openCurrentDatabase();
  assert.equal(await workoutStorage.initDB(), first);
  assert.equal(first.version, 3);
});

test("workouts repository: raw row round trip, newest startedAt first, lookups by session", async () => {
  await freshDatabase();
  await putWorkoutRow({ external_session_id: "w1", startedAt: "2026-01-01T00:00:00Z", endedAt: "e1", athlete_id: "a1" });
  await putWorkoutRow({ external_session_id: "w2", startedAt: "2026-01-02T00:00:00Z", endedAt: "e2", day: "d2" });
  await putWorkoutRow({ external_session_id: "w1", startedAt: "2026-01-01T00:00:00Z", endedAt: "e1b" });
  const rows = await readWorkoutRowsNewestFirst();
  assert.deepEqual(rows.map((row) => row.session_id), ["w2", "w1"]);
  assert.deepEqual(Object.keys(rows[1]), ["session_id", "startedAt", "endedAt", "day", "summary"]);
  assert.equal(rows[1].day, null);
  assert.equal(rows[1].endedAt, "e1b", "put upserts by session_id");
  const lookups = await getWorkoutRowsBySessionId(["w1", "missing"]);
  assert.equal(lookups[0].row.session_id, "w1");
  assert.equal(lookups[1].row, undefined);
});

test("HR samples repository: first write wins per [session, second], session-scoped reads and deletes", async () => {
  await freshDatabase();
  await addHrSampleIfAbsent("w1", 2, 102);
  await addHrSampleIfAbsent("w1", 1, 100);
  await addHrSampleIfAbsent("w1", 1, 999);
  await addHrSampleIfAbsent("w2", 1, 90);
  assert.deepEqual(await getHrSampleRows("w1"), [
    { session_id: "w1", timestamp_sec: 1, hr: 100 },
    { session_id: "w1", timestamp_sec: 2, hr: 102 },
  ]);
  await deleteHrSampleRowsForSession("w1");
  assert.deepEqual(await getHrSampleRows("w1"), []);
  assert.deepEqual(await getHrSampleRows("w2"), [{ session_id: "w2", timestamp_sec: 1, hr: 90 }]);
});

test("ordinary telemetry repository: duplicates, fresher upgrades, and source-sample identity", async () => {
  await freshDatabase();
  assert.equal(await writeOrdinaryBikeTelemetrySample(telemetrySample({ sec: 1, fresh: false })), "stored");
  assert.equal(await writeOrdinaryBikeTelemetrySample(telemetrySample({ sec: 1 })), "stored", "fresher replaces");
  assert.equal(await writeOrdinaryBikeTelemetrySample(telemetrySample({ sec: 1 })), "duplicate", "equal rank is a duplicate");
  assert.equal(
    await writeOrdinaryBikeTelemetrySample(telemetrySample({ sec: 2, snapshot: "snap-w1-1" })),
    "duplicate",
    "one source sample cannot occupy two seconds"
  );
  const rows = await getOrdinaryBikeTelemetryRows("w1");
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ["session_id", "athlete_id", "active_sec", "observed_at", "source_sample_id", "sample"]);
  assert.equal(rows[0].sample.availability, "fresh");
  assert.equal(await workoutStorage.storeOrdinaryBikeTelemetrySample({}), "rejected");
});

test("telemetry retention: strict observed_at cutoff, and cleanup deletes only unowned sessions", async () => {
  await freshDatabase();
  await writeOrdinaryBikeTelemetrySample(telemetrySample({ session: "orphan", sec: 1, at: T0 }));
  await writeOrdinaryBikeTelemetrySample(telemetrySample({ session: "owned", sec: 1, at: T0 }));
  await writeOrdinaryBikeTelemetrySample(telemetrySample({ session: "recent", sec: 1, at: T0 + 10_000 }));
  await putWorkoutRow({ external_session_id: "owned", startedAt: "s", endedAt: "e" });
  const at = new Date(T0).toISOString();
  assert.deepEqual([...(await findTelemetrySessionIdsObservedBefore(at))], [], "cutoff is exclusive");
  assert.deepEqual([...(await findTelemetrySessionIdsObservedBefore(new Date(T0 + 1).toISOString()))].sort(), ["orphan", "owned"]);
  const maxAge = workoutStorage.ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS;
  assert.equal(await workoutStorage.cleanupAbandonedOrdinaryBikeTelemetry(T0 + maxAge + 1), 1);
  assert.equal((await getOrdinaryBikeTelemetryRows("orphan")).length, 0);
  assert.equal((await getOrdinaryBikeTelemetryRows("owned")).length, 1);
  assert.equal((await getOrdinaryBikeTelemetryRows("recent")).length, 1);
  assert.equal(await workoutStorage.cleanupAbandonedOrdinaryBikeTelemetry(Number.NaN), 0);
});

test("deleteWorkoutSummary removes one session across workouts, HR samples and telemetry atomically", async () => {
  await freshDatabase();
  for (const session of ["w1", "w2"]) {
    await workoutStorage.storeWorkoutSummary({ external_session_id: session, startedAt: session, endedAt: "e" });
    await workoutStorage.storeHrSample(session, 1, 100);
    await writeOrdinaryBikeTelemetrySample(telemetrySample({ session, sec: 1 }));
  }
  assert.equal(await workoutStorage.deleteWorkoutSummary("w1"), true);
  assert.deepEqual((await readWorkoutRowsNewestFirst()).map((row) => row.session_id), ["w2"]);
  assert.deepEqual(await getHrSampleRows("w1"), []);
  assert.deepEqual(await getOrdinaryBikeTelemetryRows("w1"), []);
  assert.equal((await getHrSampleRows("w2")).length, 1);
  assert.equal((await getOrdinaryBikeTelemetryRows("w2")).length, 1);
});

test("SISU settings repository: single config row round trip", async () => {
  await freshDatabase();
  assert.equal(await getSisuSettingsRow(), null);
  const row = { key: "config", host: "h", port: 1, protocol: "https", last_connected: "t", last_sync: null };
  await putSisuSettingsRow(row);
  assert.deepEqual(await getSisuSettingsRow(), row);
  await deleteSisuSettingsRow();
  assert.equal(await getSisuSettingsRow(), null);
});

test("open failure: repositories reject, the facade keeps its sentinels", async () => {
  await freshDatabase();
  const previous = globalThis.indexedDB;
  const previousError = console.error;
  console.error = () => {};
  globalThis.indexedDB = {
    open() {
      const request = { error: new Error("open failed"), onerror: null, onsuccess: null, onupgradeneeded: null };
      setTimeout(() => request.onerror?.(), 0);
      return request;
    },
  };
  try {
    await assert.rejects(getHrSampleRows("w1"), /open failed/);
    await assert.rejects(readWorkoutRowsNewestFirst(), /open failed/);
    await assert.rejects(writeOrdinaryBikeTelemetrySample(telemetrySample({ sec: 1 })), /open failed/);
    await assert.rejects(getSisuSettingsRow(), /open failed/);
    assert.deepEqual(await workoutStorage.getHrSamples("w1"), []);
    assert.equal(await workoutStorage.storeWorkoutSummary({ external_session_id: "x", startedAt: "s", endedAt: "e" }), false);
    assert.deepEqual(await workoutStorage.getAllWorkoutSummaries(), []);
    assert.equal(await workoutStorage.deleteWorkoutSummary("w1"), false);
    assert.equal(await workoutStorage.storeOrdinaryBikeTelemetrySample(telemetrySample({ sec: 1 })), "failed");
    assert.deepEqual(await workoutStorage.getOrdinaryBikeTelemetrySamples("w1"), []);
    assert.equal(await workoutStorage.cleanupAbandonedOrdinaryBikeTelemetry(T0), 0);
    assert.equal(await workoutStorage.getSisuSettings(), null);
    assert.equal(await workoutStorage.storeSisuSettings("h", 1), false);
    assert.equal(await workoutStorage.clearSisuSettings(), false);
  } finally {
    console.error = previousError;
    globalThis.indexedDB = previous;
  }
});

test("migration stays independent of application repositories and workoutStorage", () => {
  const dir = new URL("../dist/migration/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(!/workoutStorage|persistence\/repositories|persistence\/indexedDb/.test(specifier), `${file} imports ${specifier}`);
    }
  }
});

// ---------------------------------------------------------------------------
// R3.1: completion semantics (request accepted vs succeeded vs committed)
// ---------------------------------------------------------------------------

const fakeIdb = await import("fake-indexeddb");
const indexedDbModule = await import("../dist/persistence/indexedDb.js");
const cleanupModule = await import("../dist/persistence/operations/abandonedTelemetryCleanup.js");

/**
 * Run `fn` while recording every transaction it creates, and snapshot each
 * transaction's state at the instant `fn` resolves.
 */
async function trackTransactions(fn) {
  const realTransaction = fakeIdb.IDBDatabase.prototype.transaction;
  const entries = [];
  fakeIdb.IDBDatabase.prototype.transaction = function (...args) {
    const tx = realTransaction.apply(this, args);
    const entry = { mode: tx.mode, stores: Array.from(tx.objectStoreNames), state: "active" };
    tx.addEventListener("complete", () => (entry.state = "committed"));
    tx.addEventListener("abort", () => (entry.state = "aborted"));
    entries.push(entry);
    return tx;
  };
  try {
    const outcome = await fn().then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    return { ...outcome, transactions: entries.map((entry) => ({ ...entry })) };
  } finally {
    fakeIdb.IDBDatabase.prototype.transaction = realTransaction;
  }
}

function assertWritesCommitted(transactions, stores) {
  const writes = transactions.filter((tx) => tx.mode === "readwrite");
  assert.ok(writes.length > 0, "expected a readwrite transaction");
  for (const tx of writes) assert.equal(tx.state, "committed", `readwrite ${tx.stores} must be committed on resolve`);
  assert.deepEqual([...new Set(writes.flatMap((tx) => tx.stores))].sort(), [...stores].sort());
}

/** Abort every readwrite transaction right after its first request is issued. */
async function withAbortingWrites(fn) {
  const realTransaction = fakeIdb.IDBDatabase.prototype.transaction;
  fakeIdb.IDBDatabase.prototype.transaction = function (...args) {
    const tx = realTransaction.apply(this, args);
    if (tx.mode === "readwrite") queueMicrotask(() => tx.abort());
    return tx;
  };
  try {
    return await fn();
  } finally {
    fakeIdb.IDBDatabase.prototype.transaction = realTransaction;
  }
}

/** Minimal controllable open() for timing states fake-indexeddb cannot pause. */
function controlledFactory() {
  const opens = [];
  return {
    opens,
    open() {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      opens.push(request);
      return request;
    },
    deleteDatabase() {
      const request = { onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
  };
}
function fakeConnection() {
  return { closed: false, onversionchange: null, onclose: null, close() { this.closed = true; } };
}
function succeedOpen(request, connection) {
  request.result = connection;
  request.onsuccess?.();
}

test("concurrent first callers share one in-flight open and one connection", async () => {
  const factory = controlledFactory();
  globalThis.indexedDB = factory;
  await indexedDbModule.resetCurrentDatabaseForTests();
  const calls = [indexedDbModule.openCurrentDatabase(), indexedDbModule.openCurrentDatabase(), workoutStorage.initDB()];
  assert.equal(factory.opens.length, 1);
  const connection = fakeConnection();
  succeedOpen(factory.opens[0], connection);
  for (const result of await Promise.all(calls)) assert.equal(result, connection);
  assert.equal(await indexedDbModule.openCurrentDatabase(), connection);
  assert.equal(factory.opens.length, 1);
});

test("a failed open is shared by in-flight callers, not cached, and a later call retries", async () => {
  const factory = controlledFactory();
  globalThis.indexedDB = factory;
  await indexedDbModule.resetCurrentDatabaseForTests();
  const first = indexedDbModule.openCurrentDatabase();
  const second = indexedDbModule.openCurrentDatabase();
  factory.opens[0].error = new Error("open failed");
  factory.opens[0].onerror();
  await assert.rejects(first, /open failed/);
  await assert.rejects(second, /open failed/);
  assert.equal(factory.opens.length, 1);
  const retry = indexedDbModule.openCurrentDatabase();
  assert.equal(factory.opens.length, 2);
  const connection = fakeConnection();
  succeedOpen(factory.opens[1], connection);
  assert.equal(await retry, connection);
});

test("an open in flight during reset cannot repopulate the cache afterwards", async () => {
  const factory = controlledFactory();
  globalThis.indexedDB = factory;
  await indexedDbModule.resetCurrentDatabaseForTests();
  const stale = indexedDbModule.openCurrentDatabase();
  await indexedDbModule.resetCurrentDatabaseForTests();
  const staleConnection = fakeConnection();
  succeedOpen(factory.opens[0], staleConnection);
  await assert.rejects(stale, /superseded by a reset/);
  assert.equal(staleConnection.closed, true);
  const fresh = indexedDbModule.openCurrentDatabase();
  assert.equal(factory.opens.length, 2, "cache was not repopulated by the stale open");
  const freshConnection = fakeConnection();
  succeedOpen(factory.opens[1], freshConnection);
  assert.equal(await fresh, freshConnection);
});

test("versionchange closes the cached connection; a stale handle cannot evict a newer one", async () => {
  const factory = controlledFactory();
  globalThis.indexedDB = factory;
  await indexedDbModule.resetCurrentDatabaseForTests();
  const firstOpen = indexedDbModule.openCurrentDatabase();
  const a = fakeConnection();
  succeedOpen(factory.opens[0], a);
  assert.equal(await firstOpen, a);
  a.onversionchange();
  assert.equal(a.closed, true);
  const secondOpen = indexedDbModule.openCurrentDatabase();
  assert.equal(factory.opens.length, 2, "closed connection is no longer cached");
  const b = fakeConnection();
  succeedOpen(factory.opens[1], b);
  assert.equal(await secondOpen, b);
  a.onversionchange();
  assert.equal(await indexedDbModule.openCurrentDatabase(), b);
  assert.equal(b.closed, false);
  assert.equal(factory.opens.length, 2);
});

test("versionchange on a real database lets another context upgrade without blocking", async () => {
  await freshDatabase();
  await indexedDbModule.openCurrentDatabase();
  const upgraded = await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open("fitbaus_trainer_db", 4);
    request.onblocked = () => reject(new Error("upgrade blocked by a cached connection"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(upgraded.version, 4);
  upgraded.close();
});

test("SISU settings put and delete resolve only after their transaction commits", async () => {
  await freshDatabase();
  const row = { key: "config", host: "h", port: 1, protocol: "https", last_connected: "t", last_sync: null };
  const put = await trackTransactions(() => putSisuSettingsRow(row));
  assert.equal(put.error, undefined);
  assertWritesCommitted(put.transactions, ["sisu_settings"]);
  const removed = await trackTransactions(() => deleteSisuSettingsRow());
  assert.equal(removed.error, undefined);
  assertWritesCommitted(removed.transactions, ["sisu_settings"]);
  assert.equal(await getSisuSettingsRow(), null);
});

test("SISU settings write/delete failures reject, and the facade reports false", async () => {
  await freshDatabase();
  const previousError = console.error;
  const logged = [];
  console.error = (message) => logged.push(message);
  try {
    await withAbortingWrites(async () => {
      await assert.rejects(putSisuSettingsRow({ key: "config", host: "h", port: 1, last_connected: "t", last_sync: null }));
      await assert.rejects(deleteSisuSettingsRow());
      assert.equal(await workoutStorage.storeSisuSettings("h", 1, "https"), false);
      assert.equal(await workoutStorage.clearSisuSettings(), false);
    });
  } finally {
    console.error = previousError;
  }
  assert.deepEqual(logged, ["Error storing SISU settings:", "Error clearing SISU settings:"]);
  assert.equal(await getSisuSettingsRow(), null);
});

test("HR sample add and session delete resolve only after commit", async () => {
  await freshDatabase();
  const added = await trackTransactions(() => addHrSampleIfAbsent("w1", 1, 100));
  assert.equal(added.error, undefined);
  assertWritesCommitted(added.transactions, ["hr_samples"]);
  const existing = await trackTransactions(() => addHrSampleIfAbsent("w1", 1, 999));
  assert.equal(existing.error, undefined);
  assertWritesCommitted(existing.transactions, ["hr_samples"]);
  const removed = await trackTransactions(() => deleteHrSampleRowsForSession("w1"));
  assert.equal(removed.error, undefined);
  assertWritesCommitted(removed.transactions, ["hr_samples"]);
  assert.deepEqual(await getHrSampleRows("w1"), []);
});

test("HR duplicate race: overlapping writers leave one row and both succeed", async () => {
  await freshDatabase();
  const previousError = console.error;
  const logged = [];
  console.error = (message) => logged.push(message);
  try {
    const results = await Promise.all([
      workoutStorage.storeHrSample("w1", 5, 111),
      workoutStorage.storeHrSample("w1", 5, 222),
    ]);
    assert.deepEqual(results, [undefined, undefined]);
  } finally {
    console.error = previousError;
  }
  assert.deepEqual(logged, []);
  assert.deepEqual(await getHrSampleRows("w1"), [{ session_id: "w1", timestamp_sec: 5, hr: 111 }]);
});

test("HR ConstraintError from a lost add race is success: transaction commits, first row kept", async () => {
  await freshDatabase();
  await addHrSampleIfAbsent("w1", 7, 100);
  // Force the existence check to miss so the add itself hits the real ConstraintError path.
  const realGet = fakeIdb.IDBObjectStore.prototype.get;
  fakeIdb.IDBObjectStore.prototype.get = function () {
    return realGet.call(this, ["__absent__", -1]);
  };
  let raced;
  try {
    raced = await trackTransactions(() => addHrSampleIfAbsent("w1", 7, 999));
  } finally {
    fakeIdb.IDBObjectStore.prototype.get = realGet;
  }
  assert.equal(raced.error, undefined);
  assertWritesCommitted(raced.transactions, ["hr_samples"]);
  assert.deepEqual(await getHrSampleRows("w1"), [{ session_id: "w1", timestamp_sec: 7, hr: 100 }]);
});

test("deleteBySessionIndex propagates cursor request failure", async () => {
  const failure = new Error("cursor failed");
  const request = { result: null, error: null, onsuccess: null, onerror: null };
  const store = { index: () => ({ openCursor: () => request }) };
  const enumeration = indexedDbModule.deleteBySessionIndex(store, "w1");
  request.error = failure;
  request.onerror();
  await assert.rejects(enumeration, /cursor failed/);
});

test("telemetry write/delete, workout write and cross-store delete resolve only after commit", async () => {
  await freshDatabase();
  const telemetry = await trackTransactions(() => writeOrdinaryBikeTelemetrySample(telemetrySample({ sec: 1 })));
  assert.equal(telemetry.value, "stored");
  assertWritesCommitted(telemetry.transactions, ["ordinary_bike_telemetry"]);
  const workout = await trackTransactions(() => putWorkoutRow({ external_session_id: "w1", startedAt: "s", endedAt: "e" }));
  assert.equal(workout.error, undefined);
  assertWritesCommitted(workout.transactions, ["workouts"]);
  await addHrSampleIfAbsent("w1", 1, 100);
  const removed = await trackTransactions(() => workoutStorage.deleteWorkoutSummary("w1"));
  assert.equal(removed.value, true);
  assert.equal(removed.transactions.filter((tx) => tx.mode === "readwrite").length, 1, "one atomic transaction");
  assertWritesCommitted(removed.transactions, ["workouts", "hr_samples", "ordinary_bike_telemetry"]);
  await writeOrdinaryBikeTelemetrySample(telemetrySample({ session: "w2", sec: 1 }));
  const cleared = await trackTransactions(() => workoutStorage.clearOrdinaryBikeTelemetry("w2"));
  assertWritesCommitted(cleared.transactions, ["ordinary_bike_telemetry"]);
  assert.deepEqual(await getOrdinaryBikeTelemetryRows("w2"), []);
});

test("a failed telemetry write reports failed without leaving a partial row", async () => {
  await freshDatabase();
  const previousError = console.error;
  console.error = () => {};
  try {
    const result = await withAbortingWrites(() => workoutStorage.storeOrdinaryBikeTelemetrySample(telemetrySample({ sec: 1 })));
    assert.equal(result, "failed");
  } finally {
    console.error = previousError;
  }
  assert.deepEqual(await getOrdinaryBikeTelemetryRows("w1"), []);
});

// ---------------------------------------------------------------------------
// R3.2: atomic abandoned-telemetry cleanup
// ---------------------------------------------------------------------------

const MAX_AGE = workoutStorage.ABANDONED_ORDINARY_TELEMETRY_MAX_AGE_MS;
const CLEANUP_NOW = T0 + 100 * 3600e3;
const OLD_AT = CLEANUP_NOW - MAX_AGE - 1000;
const RECENT_AT = CLEANUP_NOW - 1000;
const runCleanup = () => workoutStorage.cleanupAbandonedOrdinaryBikeTelemetry(CLEANUP_NOW);
const seedTelemetry = (session, at, sec = 1) => writeOrdinaryBikeTelemetrySample(telemetrySample({ session, sec, at }));
const telemetrySeconds = async (session) => (await getOrdinaryBikeTelemetryRows(session)).map((row) => row.active_sec);
const seedWorkout = (session) => putWorkoutRow({ external_session_id: session, startedAt: session, endedAt: "e" });

/**
 * Run `run`; the moment it creates its first transaction whose scope includes
 * `store`, start `inject` (which therefore creates its own transaction later).
 * Records every committed transaction in commit order.
 */
async function interleaveAfterFirstTransactionOn(store, inject, run) {
  const realTransaction = fakeIdb.IDBDatabase.prototype.transaction;
  const commits = [];
  let injected = null;
  fakeIdb.IDBDatabase.prototype.transaction = function (...args) {
    const tx = realTransaction.apply(this, args);
    const label = { mode: tx.mode, stores: Array.from(tx.objectStoreNames).sort().join("+") };
    tx.addEventListener("complete", () => commits.push(label));
    if (!injected && Array.from(tx.objectStoreNames).includes(store)) injected = inject();
    return tx;
  };
  try {
    const result = await run();
    await injected;
    return { result, commits };
  } finally {
    fakeIdb.IDBDatabase.prototype.transaction = realTransaction;
  }
}

test("cleanup policy: strict cutoff, ownership, whole-session deletion, session count", async () => {
  await freshDatabase();
  assert.equal(await runCleanup(), 0, "no telemetry, nothing deleted");
  await seedTelemetry("old-orphan-1", OLD_AT);
  await seedTelemetry("old-orphan-2", OLD_AT, 1);
  await seedTelemetry("old-orphan-2", OLD_AT + 1, 2);
  await seedTelemetry("mixed-orphan", OLD_AT, 1);
  await seedTelemetry("mixed-orphan", RECENT_AT, 2);
  await seedTelemetry("owned", OLD_AT);
  await seedWorkout("owned");
  await seedTelemetry("recent-orphan", RECENT_AT);
  await seedTelemetry("at-cutoff", CLEANUP_NOW - MAX_AGE);
  assert.equal(await runCleanup(), 3, "count is sessions, not rows");
  assert.deepEqual(await telemetrySeconds("old-orphan-1"), []);
  assert.deepEqual(await telemetrySeconds("old-orphan-2"), []);
  assert.deepEqual(await telemetrySeconds("mixed-orphan"), [], "old + recent unowned rows: whole session deleted");
  assert.deepEqual(await telemetrySeconds("owned"), [1]);
  assert.deepEqual(await telemetrySeconds("recent-orphan"), [1]);
  assert.deepEqual(await telemetrySeconds("at-cutoff"), [1], "observed_at == cutoff is not older than cutoff");
  assert.equal(await runCleanup(), 0);
});

test("cleanup runs as one readwrite transaction over workouts + telemetry and resolves after commit", async () => {
  await freshDatabase();
  await seedTelemetry("orphan", OLD_AT);
  const tracked = await trackTransactions(() => cleanupModule.deleteAbandonedOrdinaryBikeTelemetry(new Date(CLEANUP_NOW - MAX_AGE).toISOString()));
  assert.equal(tracked.value, 1);
  assert.equal(tracked.transactions.length, 1);
  assert.equal(tracked.transactions[0].mode, "readwrite");
  assertWritesCommitted(tracked.transactions, ["ordinary_bike_telemetry", "workouts"]);
});

test("workout race: a workout ordered before cleanup is observed; one racing cleanup is ordered after it", async () => {
  await freshDatabase();
  await seedTelemetry("before", OLD_AT);
  await indexedDbModule.openCurrentDatabase();
  const workoutFirst = seedWorkout("before");
  const cleaned = runCleanup();
  await workoutFirst;
  assert.equal(await cleaned, 0);
  assert.deepEqual(await telemetrySeconds("before"), [1], "workout ordered first preserves telemetry");

  await seedTelemetry("racing", OLD_AT);
  const { result, commits } = await interleaveAfterFirstTransactionOn("workouts", () => seedWorkout("racing"), runCleanup);
  assert.equal(result, 1, "cleanup was ordered first and saw no workout");
  assert.deepEqual(await telemetrySeconds("racing"), []);
  assert.equal((await getWorkoutRowsBySessionId(["racing"]))[0].row.session_id, "racing", "later workout still lands");
  const telemetryDelete = commits.findLastIndex((c) => c.mode === "readwrite" && c.stores.includes("ordinary_bike_telemetry"));
  const workoutWrite = commits.findIndex((c) => c.mode === "readwrite" && c.stores === "workouts");
  assert.ok(telemetryDelete >= 0 && workoutWrite >= 0);
  assert.ok(
    telemetryDelete < workoutWrite,
    "no workout may commit between cleanup's ownership decision and its deletion"
  );
});

test("telemetry race: committed-before writes are evaluated; racing writes are ordered after cleanup and survive", async () => {
  await freshDatabase();
  await seedTelemetry("before", OLD_AT, 1);
  await seedTelemetry("before", RECENT_AT, 2);
  assert.equal(await runCleanup(), 1);
  assert.deepEqual(await telemetrySeconds("before"), [], "committed state evaluated atomically (whole session)");

  await seedTelemetry("racing", OLD_AT, 1);
  const { result } = await interleaveAfterFirstTransactionOn(
    "ordinary_bike_telemetry",
    () => seedTelemetry("racing", RECENT_AT, 2),
    runCleanup
  );
  assert.equal(result, 1);
  assert.deepEqual(await telemetrySeconds("racing"), [2], "row written after cleanup's decision is not swept");
});

test("a failure mid-cleanup aborts everything: no partial deletion, facade logs and returns 0", async () => {
  await freshDatabase();
  for (const [index, session] of ["orphan-a", "orphan-b", "orphan-c"].entries()) {
    await seedTelemetry(session, OLD_AT + index);
  }
  const realOpenCursor = fakeIdb.IDBIndex.prototype.openCursor;
  fakeIdb.IDBIndex.prototype.openCursor = function (range, ...rest) {
    if (this.name === "session_id" && range?.lower === "orphan-c") throw new Error("injected cursor failure");
    return realOpenCursor.call(this, range, ...rest);
  };
  const previousError = console.error;
  const logged = [];
  console.error = (message) => logged.push(message);
  let result;
  try {
    result = await runCleanup();
  } finally {
    fakeIdb.IDBIndex.prototype.openCursor = realOpenCursor;
    console.error = previousError;
  }
  assert.equal(result, 0);
  assert.deepEqual(logged, ["Error cleaning abandoned ordinary bike telemetry:"]);
  for (const session of ["orphan-a", "orphan-b", "orphan-c"]) {
    assert.deepEqual(await telemetrySeconds(session), [1], `${session} must not be partially deleted`);
  }
});
