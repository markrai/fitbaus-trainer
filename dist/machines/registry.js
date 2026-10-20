import { proformSmartPower10Adapter } from "./proformSmartPower10.js";
const adapters = Object.freeze([proformSmartPower10Adapter]);
export const machineRegistry = Object.freeze(adapters.map((adapter) => Object.freeze({ ...adapter.definition })));
export function getMachineAdapter(id) {
    return adapters.find((adapter) => adapter.definition.id === id);
}
export function getMachineDefinition(id) {
    return machineRegistry.find((machine) => machine.id === id);
}
export function isMachineId(id) {
    return typeof id === "string" && getMachineDefinition(id) !== undefined;
}
export function listMachinesForActivity(activity) {
    return machineRegistry.filter((machine) => machine.activity === activity);
}
