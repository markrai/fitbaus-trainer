export const APP_VERSION = "0.10.13";
export function setVersionOnDom() {
    const versionEl = document.getElementById("appVersion");
    if (versionEl) {
        versionEl.textContent = "v" + APP_VERSION;
    }
    window.APP_VERSION = APP_VERSION;
}
