import { isNativeRuntime } from "./platform/runtime.js";
let lastSpokenPhase = null;
let lastMachineGuidanceKey = null;
let speechRequestId = 0;
export function getMachineGuidanceVoiceKey(event) {
    var _a, _b;
    const guidance = event.guidance;
    return [
        event.machineId,
        event.phaseId,
        guidance.action,
        (_a = guidance.resistance) !== null && _a !== void 0 ? _a : "",
        (_b = guidance.cadenceRpm) !== null && _b !== void 0 ? _b : "",
        event.phaseChanged ? "phase" : "change",
    ].join(":");
}
export function formatMachineGuidanceSpeech(event) {
    const resistance = event.guidance.resistance;
    const cadence = event.guidance.cadenceRpm;
    if (resistance === undefined || cadence === undefined)
        return null;
    if (event.phaseChanged) {
        const phase = event.phaseKind === "work" && event.intervalIndex
            ? `Interval ${event.intervalIndex}`
            : event.phaseDisplayName;
        return `${phase}. Resistance ${resistance}. Hold ${cadence} RPM.`;
    }
    if (!event.recommendationChanged)
        return null;
    if (event.guidance.action === "increase")
        return `Increase resistance to ${resistance}. Hold ${cadence} RPM.`;
    if (event.guidance.action === "decrease")
        return `Reduce resistance to ${resistance}. Hold ${cadence} RPM.`;
    return `Set resistance to ${resistance}. Hold ${cadence} RPM.`;
}
function speakText(text) {
    const requestId = ++speechRequestId;
    if (isNativeRuntime()) {
        void import("./platform/nativeSpeech.js")
            .then(({ speakNative }) => {
            if (requestId !== speechRequestId)
                return;
            return speakNative(text);
        })
            .catch((error) => console.error("Native speech error:", error));
        return;
    }
    if (!("speechSynthesis" in window))
        return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
}
function announceWorkoutGuidance(phaseDisplayName, machineEvent = null, extraPhrases = []) {
    if (!phaseDisplayName || phaseDisplayName === "Not Started") {
        resetVoiceState();
        return;
    }
    if (typeof window.getVoicePromptsEnabled !== "function" || !window.getVoicePromptsEnabled())
        return;
    const extra = extraPhrases.filter(Boolean).join(" ");
    const phaseChanged = phaseDisplayName !== lastSpokenPhase;
    if (machineEvent) {
        const event = { ...machineEvent, phaseChanged: machineEvent.phaseChanged || phaseChanged };
        const key = getMachineGuidanceVoiceKey(event);
        const text = key === lastMachineGuidanceKey ? null : formatMachineGuidanceSpeech(event);
        if (text || extra) {
            lastSpokenPhase = phaseDisplayName;
            lastMachineGuidanceKey = key;
            speakText([extra, text].filter(Boolean).join(" "));
            return;
        }
    }
    if (!phaseChanged && !extra)
        return;
    lastSpokenPhase = phaseDisplayName;
    speakText([extra, phaseChanged ? phaseDisplayName : ""].filter(Boolean).join(" ") || extra);
}
function announcePhaseIfChanged(phaseDisplayName) {
    announceWorkoutGuidance(phaseDisplayName, null);
}
function resetVoiceState() {
    lastSpokenPhase = null;
    lastMachineGuidanceKey = null;
    speechRequestId++;
    if (isNativeRuntime()) {
        void import("./platform/nativeSpeech.js")
            .then(({ stopNativeSpeech }) => stopNativeSpeech())
            .catch((error) => console.error("Native speech stop error:", error));
        return;
    }
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
}
export function registerVoiceGlobals() {
    window.announcePhaseIfChanged = announcePhaseIfChanged;
    window.announceWorkoutGuidance = announceWorkoutGuidance;
    window.resetVoiceState = resetVoiceState;
}
export { announceWorkoutGuidance, announcePhaseIfChanged, resetVoiceState };
