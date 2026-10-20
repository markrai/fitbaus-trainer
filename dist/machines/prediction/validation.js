import { integerMedian } from "../hrQuality.js";
export const MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS = 10;
export const MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS = 5;
export const MIN_SHADOW_VALIDATION_REALIZATION_RATE = 0.8;
export const MAX_SHADOW_VALIDATION_MEDIAN_ABSOLUTE_ERROR_BPM = 3;
export const MAX_SHADOW_VALIDATION_ABS_MEDIAN_BIAS_BPM = 2;
export const MIN_SHADOW_VALIDATION_DIRECTION_MATCH_RATE = 0.8;
export const SHADOW_VALIDATION_ERROR_TOLERANCE_BPM = 5;
export const MIN_SHADOW_VALIDATION_WITHIN_TOLERANCE_RATE = 0.8;
function isFiniteInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}
export function usableShadowSessionId(value) {
    return typeof value === "string" && value.trim() !== "";
}
export function shadowPredictionEventKey(event) {
    if (!usableShadowSessionId(event.sessionId))
        return undefined;
    return [
        event.sessionId,
        event.direction,
        event.phaseId,
        event.changeElapsedSeconds,
        event.fromResistance,
        event.actualToResistance,
    ].join("|");
}
function expectedOneLevelDelta(direction) {
    return direction === "increase" ? 1 : -1;
}
export function isOneLevelValidationOpportunity(event, direction) {
    if (event.direction !== direction)
        return false;
    if (!usableShadowSessionId(event.sessionId))
        return false;
    if (!isFiniteInteger(event.fromResistance) || !isFiniteInteger(event.actualToResistance))
        return false;
    if (event.actualToResistance - event.fromResistance !== expectedOneLevelDelta(direction))
        return false;
    return isFiniteInteger(event.predictedHrDeltaForActualStep);
}
export function realizedShadowValidation(event, direction) {
    if (!isOneLevelValidationOpportunity(event, direction))
        return undefined;
    if (!isFiniteInteger(event.observedHrDelta))
        return undefined;
    const signedErrorBpm = event.observedHrDelta - event.predictedHrDeltaForActualStep;
    const directionMatched = direction === "increase" ? event.observedHrDelta > 0 : event.observedHrDelta < 0;
    return {
        signedErrorBpm,
        absoluteErrorBpm: Math.abs(signedErrorBpm),
        directionMatched,
    };
}
function emptyValidation() {
    return {
        predictionOpportunityCount: 0,
        realizedPredictionCount: 0,
        distinctSessionCount: 0,
        directionMatchCount: 0,
        withinToleranceCount: 0,
        highConfidence: false,
        status: "collecting",
    };
}
function validationStatus(params) {
    if (params.highConfidence)
        return "validated";
    if (params.realizedPredictionCount < MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS ||
        params.distinctSessionCount < MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS) {
        return "collecting";
    }
    return "not_validated";
}
export function validateShadowDirection(events, direction) {
    const opportunities = events.filter((event) => isOneLevelValidationOpportunity(event, direction));
    if (opportunities.length === 0)
        return emptyValidation();
    const realized = opportunities
        .map((event) => {
        const outcome = realizedShadowValidation(event, direction);
        if (!outcome)
            return undefined;
        return { event, outcome };
    })
        .filter((item) => item !== undefined);
    const signedErrors = realized.map((item) => item.outcome.signedErrorBpm);
    const absoluteErrors = realized.map((item) => item.outcome.absoluteErrorBpm);
    const directionMatchCount = realized.filter((item) => item.outcome.directionMatched).length;
    const withinToleranceCount = realized.filter((item) => item.outcome.absoluteErrorBpm <= SHADOW_VALIDATION_ERROR_TOLERANCE_BPM).length;
    const sessionIds = new Set(realized.map((item) => item.event.sessionId).filter(usableShadowSessionId));
    const medianAbsolutePredictionErrorBpm = integerMedian(absoluteErrors);
    const medianSignedPredictionErrorBpm = integerMedian(signedErrors);
    const realizationRate = realized.length / opportunities.length;
    const directionMatchRate = realized.length > 0 ? directionMatchCount / realized.length : undefined;
    const withinToleranceRate = realized.length > 0 ? withinToleranceCount / realized.length : undefined;
    const highConfidence = realized.length >= MIN_SHADOW_VALIDATION_REALIZED_PREDICTIONS &&
        sessionIds.size >= MIN_SHADOW_VALIDATION_DISTINCT_SESSIONS &&
        realizationRate >= MIN_SHADOW_VALIDATION_REALIZATION_RATE &&
        medianAbsolutePredictionErrorBpm !== undefined &&
        medianAbsolutePredictionErrorBpm <= MAX_SHADOW_VALIDATION_MEDIAN_ABSOLUTE_ERROR_BPM &&
        medianSignedPredictionErrorBpm !== undefined &&
        Math.abs(medianSignedPredictionErrorBpm) <= MAX_SHADOW_VALIDATION_ABS_MEDIAN_BIAS_BPM &&
        directionMatchRate !== undefined &&
        directionMatchRate >= MIN_SHADOW_VALIDATION_DIRECTION_MATCH_RATE &&
        withinToleranceRate !== undefined &&
        withinToleranceRate >= MIN_SHADOW_VALIDATION_WITHIN_TOLERANCE_RATE;
    const result = {
        predictionOpportunityCount: opportunities.length,
        realizedPredictionCount: realized.length,
        realizationRate,
        distinctSessionCount: sessionIds.size,
        directionMatchCount,
        withinToleranceCount,
        highConfidence,
        status: validationStatus({
            realizedPredictionCount: realized.length,
            distinctSessionCount: sessionIds.size,
            highConfidence,
        }),
    };
    if (medianAbsolutePredictionErrorBpm !== undefined) {
        result.medianAbsolutePredictionErrorBpm = medianAbsolutePredictionErrorBpm;
    }
    if (medianSignedPredictionErrorBpm !== undefined) {
        result.medianSignedPredictionErrorBpm = medianSignedPredictionErrorBpm;
    }
    if (directionMatchRate !== undefined)
        result.directionMatchRate = directionMatchRate;
    if (withinToleranceRate !== undefined)
        result.withinToleranceRate = withinToleranceRate;
    return result;
}
export function shadowValidationStatusLabel(status) {
    if (status === "validated")
        return "Strong";
    if (status === "not_validated")
        return "Needs improvement";
    return "Collecting";
}
