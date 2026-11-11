/**
 * When Downregulation is active, #workoutMainSection (z-index 10) would otherwise
 * intercept taps meant for #downregulationContainer (z-index 5). CSS uses this
 * class to set pointer-events: none on the section while restoring them on
 * .workout-day-row so the workout selector stays usable.
 */

export const DOWNREGULATION_ACTIVE_CLASS = "downregulation-active";

export function setWorkoutMainSectionDownregulationActive(
  mainSection: { classList: { toggle(token: string, force?: boolean): boolean } } | null,
  active: boolean
): void {
  mainSection?.classList.toggle(DOWNREGULATION_ACTIVE_CLASS, active);
}
