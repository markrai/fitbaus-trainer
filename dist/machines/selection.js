import { getMachineDefinition, isMachineId } from "./registry.js";
export const EQUIPMENT_STORAGE_KEY = "fitbaus_trainer_equipment_selection";
function storageOrBrowser(storage) {
    return storage !== null && storage !== void 0 ? storage : localStorage;
}
function sanitizeSelection(value) {
    var _a, _b;
    if (!value || typeof value !== "object")
        return {};
    const raw = value;
    const selection = {};
    if (isMachineId(raw.bike) && ((_a = getMachineDefinition(raw.bike)) === null || _a === void 0 ? void 0 : _a.activity) === "bike")
        selection.bike = raw.bike;
    if (isMachineId(raw.elliptical) && ((_b = getMachineDefinition(raw.elliptical)) === null || _b === void 0 ? void 0 : _b.activity) === "elliptical") {
        selection.elliptical = raw.elliptical;
    }
    return selection;
}
export function getEquipmentSelection(storage) {
    try {
        const raw = storageOrBrowser(storage).getItem(EQUIPMENT_STORAGE_KEY);
        return raw ? sanitizeSelection(JSON.parse(raw)) : {};
    }
    catch {
        return {};
    }
}
export function saveEquipmentSelection(selection, storage) {
    const clean = sanitizeSelection(selection);
    storageOrBrowser(storage).setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(clean));
    return clean;
}
export function setSelectedMachine(activity, machineId, storage) {
    const selection = getEquipmentSelection(storage);
    if (machineId === undefined)
        delete selection[activity];
    else {
        const definition = getMachineDefinition(machineId);
        if (!definition || definition.activity !== activity)
            throw new Error(`Machine ${machineId} does not support ${activity}`);
        selection[activity] = machineId;
    }
    return saveEquipmentSelection(selection, storage);
}
export function getSelectedMachineId(activity, storage) {
    const selection = getEquipmentSelection(storage);
    if (activity === "bike" || activity === "elliptical")
        return selection[activity];
    return undefined;
}
export function resolveSelectedMachine(activity, storage) {
    const id = getSelectedMachineId(activity, storage);
    return id ? getMachineDefinition(id) : undefined;
}
