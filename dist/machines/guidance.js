import { getMachineAdapter } from "./registry.js";
export function createMachineGuidanceState() {
    return {
        shortIntervalEvaluated: false,
        mediumIntervalEvaluated: false,
    };
}
export function getMachineGuidance(context, state) {
    const adapter = getMachineAdapter(context.machineId);
    if (!adapter || adapter.definition.activity !== context.activity)
        return null;
    return adapter.getGuidance(context, state);
}
export function isSameMachineRecommendation(previous, next) {
    return (previous === null || previous === void 0 ? void 0 : previous.machineId) === next.machineId &&
        previous.resistance === next.resistance &&
        previous.cadenceRpm === next.cadenceRpm &&
        previous.estimatedWatts === next.estimatedWatts;
}
