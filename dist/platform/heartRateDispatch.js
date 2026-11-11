import { parseHeartRateMeasurement } from "./heartRateMeasurement.js";
export function dispatchHeartRateMeasurement(value, handlers) {
    var _a, _b, _c, _d;
    const measurement = parseHeartRateMeasurement(value);
    handlers.onBpm(measurement.bpm);
    if (measurement.optionalFieldError) {
        (_a = handlers.onOptionalFieldError) === null || _a === void 0 ? void 0 : _a.call(handlers, measurement.optionalFieldError);
        return;
    }
    if (measurement.rrIntervalsMs.length > 0) {
        (_b = handlers.onClearOptionalFieldError) === null || _b === void 0 ? void 0 : _b.call(handlers);
        (_c = handlers.onRrIntervals) === null || _c === void 0 ? void 0 : _c.call(handlers, measurement.rrIntervalsMs);
        return;
    }
    (_d = handlers.onOptionalFieldsOk) === null || _d === void 0 ? void 0 : _d.call(handlers);
}
