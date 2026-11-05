/**
 * When Downregulation is active, #workoutMainSection (z-index 10) would otherwise
 * intercept taps meant for #downregulationContainer (z-index 5). CSS uses this
 * class to set pointer-events: none on the section while restoring them on
 * .workout-day-row so the workout selector stays usable.
 */
export const DOWNREGULATION_ACTIVE_CLASS = "downregulation-active";
export function setWorkoutMainSectionDownregulationActive(mainSection, active) {
    mainSection === null || mainSection === void 0 ? void 0 : mainSection.classList.toggle(DOWNREGULATION_ACTIVE_CLASS, active);
}
