import {
  LEGACY_HR_TARGET_RESOLVER_ID,
  LEGACY_HR_TARGET_RESOLVER_VERSION,
  WORKOUT_PRESCRIPTION_RESOLVER_ID,
  WORKOUT_PRESCRIPTION_RESOLVER_VERSION,
  WORKOUT_PRESCRIPTION_SCHEMA_VERSION,
  type HrTargetsForDay,
  type PhaseIntensityId,
  type PlanBlock,
  type ResolvedHeartRateTarget,
  type ResolvedWorkoutPhaseTarget,
  type ResolvedWorkoutPrescription,
  type WorkoutPhaseKind,
} from "./types.js";

export const SUPPORTED_WORKOUT_PRESCRIPTION_RESOLVERS = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    id: LEGACY_HR_TARGET_RESOLVER_ID,
    version: LEGACY_HR_TARGET_RESOLVER_VERSION,
  }),
]);

const PHASE_KINDS = new Set<WorkoutPhaseKind>(["warmup", "work", "recovery", "cooldown"]);
const INTENSITY_IDS = new Set<PhaseIntensityId>([
  "warmup_easy",
  "aerobic_base",
  "threshold",
  "vo2_short",
  "vo2_long",
  "recovery",
  "cooldown",
  "strength_support",
]);

export interface ResolveWorkoutPrescriptionInput {
  workoutSelector: string;
  blocks: PlanBlock;
  hrTargets: HrTargetsForDay | null;
  /** Explicit input keeps resolution deterministic and makes the frozen instant auditable. */
  resolvedAt: string;
}

const MAX_PERSISTED_PHASES = 100;
const MAX_PERSISTED_REPETITIONS = 1000;
const MAX_PERSISTED_DURATION_MINUTES = 24 * 60;

export function parseLegacyHeartRateTarget(value: string | number | null | undefined): ResolvedHeartRateTarget | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const greaterThanCapMatch = text.match(/≥(\d+)\s*\(cap\s*(\d+)\)/);
  if (greaterThanCapMatch) return { min: parseInt(greaterThanCapMatch[1]), max: parseInt(greaterThanCapMatch[2]) };
  const greaterThanMatch = text.match(/≥(\d+)/);
  if (greaterThanMatch) return { min: parseInt(greaterThanMatch[1]), max: 200 };
  const rangeMatch = text.match(/(\d+)[–-](\d+)/);
  if (rangeMatch) return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) };
  const lessThanMatch = text.match(/<(\d+)/);
  if (lessThanMatch) return { min: 0, max: parseInt(lessThanMatch[1]) - 1 };
  const singleMatch = text.match(/(\d+)/);
  if (!singleMatch) return null;
  const target = parseInt(singleMatch[1]);
  return { min: target - 5, max: target + 5 };
}

/**
 * Sanitize the normalized legacy target snapshot stored with a session.
 * This is deliberately separate from data.json template parsing: persisted session data is untrusted
 * and can regain controller authority only after every legacy target and runtime-shaping field passes.
 */
export function parsePersistedHrTargetsForDay(value: unknown): HrTargetsForDay | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const result: HrTargetsForDay = { intervals: null };

  const warmup = parseOptionalPersistedLegacyTarget(raw.warmup);
  const cooldown = parseOptionalPersistedLegacyTarget(raw.cooldown);
  const mainSet = parseOptionalPersistedLegacyTarget(raw.main_set);
  if (!warmup.valid || !cooldown.valid || !mainSet.valid) return null;
  if (warmup.value !== undefined) result.warmup = warmup.value;
  if (cooldown.value !== undefined) result.cooldown = cooldown.value;
  if (mainSet.value !== undefined) result.main_set = mainSet.value;

  const warmupIntensity = parseOptionalIntensityId(raw.warmup_intensity_id);
  const cooldownIntensity = parseOptionalIntensityId(raw.cooldown_intensity_id);
  const mainSetIntensity = parseOptionalIntensityId(raw.main_set_intensity_id);
  if (!warmupIntensity.valid || !cooldownIntensity.valid || !mainSetIntensity.valid) return null;
  if (warmupIntensity.value) result.warmup_intensity_id = warmupIntensity.value;
  if (cooldownIntensity.value) result.cooldown_intensity_id = cooldownIntensity.value;
  if (mainSetIntensity.value) result.main_set_intensity_id = mainSetIntensity.value;

  if (raw.main_set_kind !== undefined) {
    if (!PHASE_KINDS.has(raw.main_set_kind as WorkoutPhaseKind)) return null;
    result.main_set_kind = raw.main_set_kind as WorkoutPhaseKind;
  }

  if (raw.warmup_subsections !== undefined && raw.warmup_subsections !== null) {
    if (!Array.isArray(raw.warmup_subsections) || raw.warmup_subsections.length > MAX_PERSISTED_PHASES) return null;
    const subsections: NonNullable<HrTargetsForDay["warmup_subsections"]> = [];
    let previousEnd = 0;
    for (const value of raw.warmup_subsections) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const subsection = value as Record<string, unknown>;
      if (typeof subsection.name !== "string" || subsection.name.trim() === "") return null;
      if (!isNonNegativeFiniteNumber(subsection.start_min) || !isPositiveFiniteNumber(subsection.end_min)) return null;
      if ((subsection.end_min as number) <= (subsection.start_min as number)) return null;
      if ((subsection.start_min as number) < previousEnd) return null;
      const target = parseOptionalPersistedLegacyTarget(subsection.target_hr_bpm);
      const intensity = parseOptionalIntensityId(subsection.intensity_id);
      if (!target.valid || target.value === undefined || !intensity.valid) return null;
      const parsed = {
        name: subsection.name,
        start_min: subsection.start_min as number,
        end_min: subsection.end_min as number,
        target_hr_bpm: target.value,
        intensity_id: intensity.value,
      };
      if (!parsed.intensity_id) delete parsed.intensity_id;
      subsections.push(parsed);
      previousEnd = parsed.end_min;
    }
    result.warmup_subsections = subsections;
  }

  if (raw.intervals === null) return result;
  if (!raw.intervals || typeof raw.intervals !== "object" || Array.isArray(raw.intervals)) return null;
  const intervals = raw.intervals as Record<string, unknown>;
  if (!Array.isArray(intervals.phases) || intervals.phases.length === 0 || intervals.phases.length > MAX_PERSISTED_PHASES) return null;
  if (!Number.isInteger(intervals.repetitions) || (intervals.repetitions as number) <= 0 || (intervals.repetitions as number) > MAX_PERSISTED_REPETITIONS) return null;
  if (typeof intervals.isSequence !== "boolean") return null;
  if (intervals.isSequence && intervals.repetitions !== 1) return null;
  const phases = [];
  for (const value of intervals.phases) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const phase = value as Record<string, unknown>;
    if (typeof phase.phase !== "string" || phase.phase.trim() === "") return null;
    if (!PHASE_KINDS.has(phase.kind as WorkoutPhaseKind)) return null;
    if (!isPositiveFiniteNumber(phase.duration) || (phase.duration as number) > MAX_PERSISTED_DURATION_MINUTES) return null;
    const target = parseOptionalPersistedLegacyTarget(phase.target_hr_bpm);
    const intensity = parseOptionalIntensityId(phase.intensity_id);
    if (!target.valid || !intensity.valid) return null;
    const parsed = {
      phase: phase.phase,
      kind: phase.kind as WorkoutPhaseKind,
      duration: phase.duration as number,
      target_hr_bpm: target.value,
      intensity_id: intensity.value,
    };
    if (parsed.target_hr_bpm === undefined) delete parsed.target_hr_bpm;
    if (!parsed.intensity_id) delete parsed.intensity_id;
    phases.push(parsed);
  }
  result.intervals = {
    phases,
    repetitions: intervals.repetitions as number,
    isSequence: intervals.isSequence,
  };
  return result;
}

export function persistedHrTargetsFitBlocks(targets: HrTargetsForDay, blocks: PlanBlock): boolean {
  if (targets.warmup_subsections?.some((subsection) => subsection.end_min > blocks.warm)) return false;
  if (!targets.intervals) return true;
  const cycleMinutes = targets.intervals.phases.reduce((sum, phase) => sum + phase.duration, 0);
  const expectedMinutes = cycleMinutes * (targets.intervals.isSequence ? 1 : targets.intervals.repetitions);
  return Number.isFinite(expectedMinutes) && Math.abs(expectedMinutes - blocks.sustain) < 1e-9;
}

function parseOptionalPersistedLegacyTarget(value: unknown): {
  valid: boolean;
  value?: string | number;
} {
  if (value === undefined || value === "") return { valid: true };
  if (typeof value !== "string" && !isFiniteNumber(value)) return { valid: false };
  const parsed = parseLegacyHeartRateTarget(value as string | number);
  if (
    !parsed ||
    !isNonNegativeFiniteNumber(parsed.min) ||
    !isPositiveFiniteNumber(parsed.max) ||
    parsed.min > parsed.max ||
    parsed.max < 30 ||
    parsed.max > 250
  ) {
    return { valid: false };
  }
  return { valid: true, value: value as string | number };
}

function parseOptionalIntensityId(value: unknown): { valid: boolean; value?: PhaseIntensityId } {
  if (value === undefined) return { valid: true };
  if (!INTENSITY_IDS.has(value as PhaseIntensityId)) return { valid: false };
  return { valid: true, value: value as PhaseIntensityId };
}

function phaseTarget(input: Omit<ResolvedWorkoutPhaseTarget, "source" | "quality" | "explanationCode" | "expectedHeartRate"> & {
  target?: string | number;
}): ResolvedWorkoutPhaseTarget {
  const expectedHeartRate = parseLegacyHeartRateTarget(input.target);
  const { target, ...base } = input;
  return {
    ...base,
    displayTargetHrBpm: target,
    expectedHeartRate: expectedHeartRate ?? undefined,
    source: expectedHeartRate ? "legacy_fallback" : "no_numeric_target",
    quality: "unverified",
    explanationCode: expectedHeartRate ? "legacy_target_hr_bpm" : "no_numeric_target",
  };
}

export function resolveWorkoutPrescription(input: ResolveWorkoutPrescriptionInput): ResolvedWorkoutPrescription {
  const phases: ResolvedWorkoutPhaseTarget[] = [];
  const targets = input.hrTargets;
  if (input.blocks.warm > 0) {
    phases.push(phaseTarget({
      phaseId: "warmup",
      kind: "warmup",
      intensityId: targets?.warmup_intensity_id,
      target: targets?.warmup,
    }));
    for (const subsection of targets?.warmup_subsections ?? []) {
      phases.push(phaseTarget({
        phaseId: "warmup",
        kind: "warmup",
        intensityId: subsection.intensity_id ?? targets?.warmup_intensity_id,
        detailName: subsection.name,
        activeStartSec: subsection.start_min * 60,
        activeEndSec: subsection.end_min * 60,
        target: subsection.target_hr_bpm,
      }));
    }
  }
  if (input.blocks.sustain > 0) {
    const intervals = targets?.intervals;
    if (intervals?.phases.length) {
      const repetitions = intervals.isSequence ? 1 : intervals.repetitions;
      let activeStartSec = input.blocks.warm * 60;
      for (let cycle = 0; cycle < repetitions; cycle++) {
        let workIndex = 0;
        intervals.phases.forEach((interval, phaseIndex) => {
          if (interval.kind === "work") workIndex++;
          const durationSec = interval.duration * 60;
          phases.push(phaseTarget({
            phaseId: intervals.isSequence ? `sequence:${phaseIndex}` : `cycle:${cycle}:${phaseIndex}`,
            kind: interval.kind,
            intensityId: interval.intensity_id,
            detailName: interval.phase,
            intervalIndex: intervals.isSequence ? Math.max(1, workIndex) : cycle + 1,
            activeStartSec,
            activeEndSec: activeStartSec + durationSec,
            target: interval.target_hr_bpm,
          }));
          activeStartSec += durationSec;
        });
      }
    } else {
      phases.push(phaseTarget({
        phaseId: "sustain",
        kind: targets?.main_set_kind ?? "work",
        intensityId: targets?.main_set_intensity_id,
        target: targets?.main_set,
      }));
    }
  }
  if (input.blocks.cool > 0) {
    phases.push(phaseTarget({
      phaseId: "cooldown",
      kind: "cooldown",
      intensityId: targets?.cooldown_intensity_id,
      target: targets?.cooldown,
    }));
  }
  return {
    schemaVersion: WORKOUT_PRESCRIPTION_SCHEMA_VERSION,
    resolver: { id: WORKOUT_PRESCRIPTION_RESOLVER_ID, version: WORKOUT_PRESCRIPTION_RESOLVER_VERSION },
    workoutSelector: input.workoutSelector,
    resolvedAt: input.resolvedAt,
    phases,
  };
}

export function findResolvedPhaseTarget(
  prescription: ResolvedWorkoutPrescription | null | undefined,
  phaseId: string,
  workoutElapsedSec?: number
): ResolvedWorkoutPhaseTarget | undefined {
  const matches = prescription?.phases.filter((phase) => phase.phaseId === phaseId) ?? [];
  if (workoutElapsedSec !== undefined) {
    const timed = matches.find((phase) => phase.activeStartSec !== undefined && phase.activeEndSec !== undefined && workoutElapsedSec >= phase.activeStartSec && workoutElapsedSec < phase.activeEndSec);
    if (timed) return timed;
  }
  return matches.find((phase) => phase.activeStartSec === undefined && phase.activeEndSec === undefined) ?? matches[0];
}

export function formatResolvedHeartRateTarget(target: ResolvedWorkoutPhaseTarget | null | undefined): string {
  return target?.displayTargetHrBpm !== undefined ? `${target.displayTargetHrBpm} bpm` : "";
}

export function machineHeartRateTargetFromResolved(target: ResolvedWorkoutPhaseTarget | null | undefined): {
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
} {
  return {
    targetHeartRateMin: target?.expectedHeartRate?.min,
    targetHeartRateMax: target?.expectedHeartRate?.max,
  };
}

export function parseResolvedWorkoutPrescription(value: unknown): ResolvedWorkoutPrescription | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  if (!raw.resolver || typeof raw.resolver !== "object" || Array.isArray(raw.resolver)) return null;
  const resolver = raw.resolver as Record<string, unknown>;
  if (
    resolver.id !== LEGACY_HR_TARGET_RESOLVER_ID ||
    resolver.version !== LEGACY_HR_TARGET_RESOLVER_VERSION
  ) {
    return null;
  }
  return parseLegacyPrescriptionV1(raw);
}

function parseLegacyPrescriptionV1(raw: Record<string, unknown>): ResolvedWorkoutPrescription | null {
  if (typeof raw.workoutSelector !== "string" || raw.workoutSelector.trim() === "") return null;
  if (typeof raw.resolvedAt !== "string" || raw.resolvedAt.trim() === "") return null;
  if (!Array.isArray(raw.phases)) return null;
  const phases: ResolvedWorkoutPhaseTarget[] = [];
  for (const value of raw.phases) {
    const phase = parseLegacyPhaseTargetV1(value);
    if (!phase) return null;
    phases.push(phase);
  }
  return {
    schemaVersion: 1,
    resolver: {
      id: LEGACY_HR_TARGET_RESOLVER_ID,
      version: LEGACY_HR_TARGET_RESOLVER_VERSION,
    },
    workoutSelector: raw.workoutSelector,
    resolvedAt: raw.resolvedAt,
    phases,
  };
}

function parseLegacyPhaseTargetV1(value: unknown): ResolvedWorkoutPhaseTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.phaseId !== "string" || raw.phaseId.trim() === "") return null;
  if (!PHASE_KINDS.has(raw.kind as WorkoutPhaseKind)) return null;
  if (raw.intensityId !== undefined && !INTENSITY_IDS.has(raw.intensityId as PhaseIntensityId)) return null;
  if (raw.detailName !== undefined && (typeof raw.detailName !== "string" || raw.detailName.trim() === "")) return null;
  if (raw.intervalIndex !== undefined && (!Number.isInteger(raw.intervalIndex) || (raw.intervalIndex as number) <= 0)) return null;

  const hasStart = raw.activeStartSec !== undefined;
  const hasEnd = raw.activeEndSec !== undefined;
  if (hasStart !== hasEnd) return null;
  if (hasStart) {
    if (!isNonNegativeFiniteNumber(raw.activeStartSec) || !isNonNegativeFiniteNumber(raw.activeEndSec)) return null;
    if ((raw.activeEndSec as number) <= (raw.activeStartSec as number)) return null;
  }

  if (
    raw.displayTargetHrBpm !== undefined &&
    typeof raw.displayTargetHrBpm !== "string" &&
    !isFiniteNumber(raw.displayTargetHrBpm)
  ) {
    return null;
  }

  const expectedHeartRate = parsePersistedHeartRateTarget(raw.expectedHeartRate);
  if (raw.expectedHeartRate !== undefined && !expectedHeartRate) return null;
  const parsedDisplayTarget = raw.displayTargetHrBpm !== undefined
    ? parseLegacyHeartRateTarget(raw.displayTargetHrBpm as string | number)
    : null;
  if (raw.source !== "legacy_fallback" && raw.source !== "no_numeric_target") return null;
  if (raw.quality !== "unverified") return null;
  if (raw.explanationCode !== "legacy_target_hr_bpm" && raw.explanationCode !== "no_numeric_target") return null;
  if (raw.source === "legacy_fallback") {
    if (!expectedHeartRate || raw.explanationCode !== "legacy_target_hr_bpm") return null;
    if (raw.displayTargetHrBpm === undefined) return null;
    if (
      !parsedDisplayTarget ||
      parsedDisplayTarget.min !== expectedHeartRate.min ||
      parsedDisplayTarget.max !== expectedHeartRate.max
    ) {
      return null;
    }
  } else if (
    expectedHeartRate ||
    parsedDisplayTarget ||
    raw.explanationCode !== "no_numeric_target"
  ) {
    return null;
  }

  const phase: ResolvedWorkoutPhaseTarget = {
    phaseId: raw.phaseId,
    kind: raw.kind as WorkoutPhaseKind,
    source: raw.source,
    quality: "unverified",
    explanationCode: raw.explanationCode,
  };
  if (raw.intensityId !== undefined) phase.intensityId = raw.intensityId as PhaseIntensityId;
  if (raw.detailName !== undefined) phase.detailName = raw.detailName as string;
  if (raw.intervalIndex !== undefined) phase.intervalIndex = raw.intervalIndex as number;
  if (hasStart) {
    phase.activeStartSec = raw.activeStartSec as number;
    phase.activeEndSec = raw.activeEndSec as number;
  }
  if (raw.displayTargetHrBpm !== undefined) {
    phase.displayTargetHrBpm = raw.displayTargetHrBpm as string | number;
  }
  if (expectedHeartRate) phase.expectedHeartRate = expectedHeartRate;
  return phase;
}

function parsePersistedHeartRateTarget(value: unknown): ResolvedHeartRateTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const hasMin = raw.min !== undefined;
  const hasMax = raw.max !== undefined;
  if (!hasMin || !hasMax) return null;
  if (hasMin && !isNonNegativeFiniteNumber(raw.min)) return null;
  if (hasMax && !isNonNegativeFiniteNumber(raw.max)) return null;
  if (hasMin && hasMax && (raw.min as number) > (raw.max as number)) return null;
  const target: ResolvedHeartRateTarget = {};
  if (hasMin) target.min = raw.min as number;
  if (hasMax) target.max = raw.max as number;
  return target;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
