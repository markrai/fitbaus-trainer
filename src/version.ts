export const APP_VERSION = "0.10.14";

export function setVersionOnDom() {
  const versionEl = document.getElementById("appVersion");
  if (versionEl) {
    versionEl.textContent = "v" + APP_VERSION;
  }
  (window as any).APP_VERSION = APP_VERSION;
}
