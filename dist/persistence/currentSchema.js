/**
 * Canonical CURRENT FitBaus Trainer IndexedDB contract.
 *
 * Immutable facts about the database this version of FitBaus Trainer owns:
 * name, version, store names, key paths, and indexes. Normal storage
 * (workoutStorage) and the legacy-migration destination both create the
 * database through applyCurrentSchemaUpgrade, so the two cannot drift.
 *
 * Changing anything here is a persisted-schema change and requires a
 * CURRENT_DB_VERSION bump with an explicit upgrade path.
 */
export const CURRENT_DB_NAME = "fitbaus_trainer_db";
export const CURRENT_DB_VERSION = 3;
export const CURRENT_STORE_NAMES = ["workouts", "hr_samples", "ordinary_bike_telemetry", "sisu_settings"];
function freezeStore(definition) {
    for (const index of definition.indexes) {
        if (typeof index.keyPath !== "string")
            Object.freeze(index.keyPath);
        Object.freeze(index);
    }
    if (typeof definition.keyPath !== "string")
        Object.freeze(definition.keyPath);
    Object.freeze(definition.indexes);
    return Object.freeze(definition);
}
/** Store definitions in creation order (matches CURRENT_STORE_NAMES). */
export const CURRENT_STORES = Object.freeze({
    workouts: freezeStore({
        keyPath: "session_id",
        indexes: [
            { name: "startedAt", keyPath: "startedAt", unique: false },
            { name: "day", keyPath: "day", unique: false },
        ],
    }),
    hr_samples: freezeStore({
        keyPath: ["session_id", "timestamp_sec"],
        indexes: [{ name: "session_id", keyPath: "session_id", unique: false }],
    }),
    ordinary_bike_telemetry: freezeStore({
        keyPath: ["session_id", "active_sec"],
        indexes: [
            { name: "session_id", keyPath: "session_id", unique: false },
            { name: "observed_at", keyPath: "observed_at", unique: false },
            { name: "session_source_id", keyPath: ["session_id", "source_sample_id"], unique: false },
        ],
    }),
    sisu_settings: freezeStore({
        keyPath: "key",
        indexes: [],
    }),
});
function mutableKeyPath(keyPath) {
    return typeof keyPath === "string" ? keyPath : [...keyPath];
}
/**
 * onupgradeneeded only. Creates each missing current store together with the
 * indexes defined for it. Existing stores are left untouched (no indexes are
 * added to them), so any change to an existing store requires an explicit
 * versioned upgrade step.
 */
export function applyCurrentSchemaUpgrade(database) {
    for (const name of CURRENT_STORE_NAMES) {
        if (database.objectStoreNames.contains(name))
            continue;
        const definition = CURRENT_STORES[name];
        const store = database.createObjectStore(name, { keyPath: mutableKeyPath(definition.keyPath) });
        for (const index of definition.indexes) {
            store.createIndex(index.name, mutableKeyPath(index.keyPath), { unique: index.unique });
        }
    }
}
