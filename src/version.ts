export const APP_VERSION = "1.0.0";

export function setVersionOnDom() {
  const versionEl = document.getElementById("appVersion");
  if (versionEl) {
    versionEl.textContent = "v" + APP_VERSION;
  }
  (window as any).APP_VERSION = APP_VERSION;
}
