import { APP_VERSION } from "./version.js";
import { isNativeRuntime } from "./platform/runtime.js";
let serviceWorkerRegistration = null;
let updateAvailable = false;
let updateNotificationShown = false;
function showUpdateNotification() {
    if (document.getElementById("updateNotification") || updateNotificationShown)
        return;
    updateNotificationShown = true;
    const notification = document.createElement("div");
    notification.id = "updateNotification";
    notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #3d7cff;
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.9rem;
    max-width: 90%;
  `;
    notification.innerHTML = `
    <span>New version available!</span>
    <button onclick="reloadForUpdate()" style="
      background: white;
      color: #3d7cff;
      border: none;
      padding: 6px 16px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.85rem;
    ">Update Now</button>
    <button onclick="dismissUpdateNotification()" style="
      background: transparent;
      color: white;
      border: 1px solid rgba(255,255,255,0.3);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
    ">Later</button>
  `;
    document.body.appendChild(notification);
}
function reloadForUpdate() {
    const notification = document.getElementById("updateNotification");
    if (notification)
        notification.remove();
    if (serviceWorkerRegistration && serviceWorkerRegistration.waiting) {
        serviceWorkerRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
    sessionStorage.setItem("updateApplied", "true");
    setTimeout(() => window.location.reload(), 100);
}
function dismissUpdateNotification() {
    const notification = document.getElementById("updateNotification");
    if (notification)
        notification.remove();
    updateNotificationShown = false;
}
let deferredPrompt;
let installButton = null;
let installPromptEscHandler = null;
function isAppInstalled() {
    return (window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches ||
        window.navigator.standalone === true);
}
function refreshInstallTabContent() {
    const notInstalledEl = document.getElementById("installNotInstalledState");
    const installedEl = document.getElementById("installInstalledState");
    if (!notInstalledEl || !installedEl)
        return;
    if (isAppInstalled()) {
        notInstalledEl.style.display = "none";
        installedEl.style.display = "block";
    }
    else {
        notInstalledEl.style.display = "block";
        installedEl.style.display = "none";
    }
}
function createInstallButton() {
    if (isAppInstalled()) {
        refreshInstallTabContent();
        return;
    }
    if (document.getElementById("installButton")) {
        installButton = document.getElementById("installButton");
        return;
    }
    const button = document.createElement("button");
    button.id = "installButton";
    button.className = "button";
    button.textContent = "Install App";
    button.style.display = "none";
    button.onclick = installPWA;
    const installContainer = document.getElementById("installButtonContainer");
    if (installContainer) {
        installContainer.appendChild(button);
        installButton = button;
    }
}
function installPWA() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            deferredPrompt = null;
            if (installButton)
                installButton.style.display = "none";
        });
    }
}
function showInstallPrompt() {
    if (deferredPrompt && !window.matchMedia("(display-mode: standalone)").matches) {
        const promptModal = document.createElement("div");
        promptModal.className = "modal-bg";
        promptModal.id = "installPromptBg";
        promptModal.style.display = "flex";
        promptModal.innerHTML = `
      <div class="modal">
        <div class="close-btn" onclick="closeInstallPrompt()">✕</div>
        <div class="modal-title">Install FitBaus Trainer</div>
        <div class="label" style="text-align:center; margin: 20px 0;">
          Install this app on your device for a better experience and offline access.
        </div>
        <div class="modal-actions">
          <button class="button" onclick="installPWAFromPrompt()">Install</button>
          <button class="button secondary" onclick="closeInstallPrompt()">Not Now</button>
        </div>
      </div>
    `;
        document.body.appendChild(promptModal);
        installPromptEscHandler = (e) => {
            if (e.key === "Escape" || e.keyCode === 27)
                closeInstallPrompt();
        };
        document.addEventListener("keydown", installPromptEscHandler);
        localStorage.setItem("installPromptShown", Date.now().toString());
    }
}
function closeInstallPrompt() {
    const promptModal = document.getElementById("installPromptBg");
    if (promptModal) {
        promptModal.style.display = "none";
        promptModal.remove();
    }
    if (installPromptEscHandler) {
        document.removeEventListener("keydown", installPromptEscHandler);
        installPromptEscHandler = null;
    }
}
function installPWAFromPrompt() {
    installPWA();
    closeInstallPrompt();
}
function shouldShowInstallPrompt() {
    const lastShown = localStorage.getItem("installPromptShown");
    if (!lastShown)
        return true;
    const lastShownTime = parseInt(lastShown);
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return lastShownTime < oneDayAgo;
}
function registerServiceWorker() {
    if (!("serviceWorker" in navigator))
        return;
    // In local development, Service Worker caching can make it look like builds "don't apply".
    // Skip SW registration on localhost unless explicitly enabled.
    const isLocalhost = window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname === "[::1]";
    if (isLocalhost && localStorage.getItem("enableServiceWorkerDev") !== "true") {
        console.log("Skipping Service Worker registration on localhost (set enableServiceWorkerDev=true to enable).");
        return;
    }
    window.addEventListener("load", () => {
        const swUrl = "/sw.js?v=" + (typeof window.APP_VERSION !== "undefined" ? window.APP_VERSION : APP_VERSION);
        navigator.serviceWorker
            .register(swUrl)
            .then((registration) => {
            serviceWorkerRegistration = registration;
            if (registration.waiting && !sessionStorage.getItem("updateApplied")) {
                updateAvailable = true;
                showUpdateNotification();
            }
            else if (sessionStorage.getItem("updateApplied")) {
                sessionStorage.removeItem("updateApplied");
            }
            registration.addEventListener("updatefound", () => {
                const newWorker = registration.installing;
                if (!newWorker)
                    return;
                newWorker.addEventListener("statechange", () => {
                    if (newWorker.state === "installed") {
                        if (navigator.serviceWorker.controller) {
                            updateAvailable = true;
                            if (!updateNotificationShown)
                                showUpdateNotification();
                        }
                    }
                });
            });
            setInterval(() => {
                registration.update();
            }, 5 * 60 * 1000);
        })
            .catch((error) => console.log("ServiceWorker registration failed:", error));
    });
}
function registerInstallPromptHandlers() {
    window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        deferredPrompt = e;
        if (installButton)
            installButton.style.display = "block";
        else {
            createInstallButton();
            if (installButton)
                installButton.style.display = "block";
        }
        setTimeout(() => {
            showInstallPrompt();
        }, 3000);
    });
    window.addEventListener("load", () => {
        refreshInstallTabContent();
        createInstallButton();
        if (isAppInstalled())
            return;
        setTimeout(() => {
            if (deferredPrompt && shouldShowInstallPrompt()) {
                showInstallPrompt();
            }
        }, 5000);
    });
    window.addEventListener("appinstalled", () => {
        deferredPrompt = null;
        if (installButton)
            installButton.style.display = "none";
        closeInstallPrompt();
        refreshInstallTabContent();
    });
}
function disableNativeInstallUi() {
    var _a, _b, _c;
    (_a = document.getElementById("installTabButton")) === null || _a === void 0 ? void 0 : _a.remove();
    (_b = document.getElementById("installTab")) === null || _b === void 0 ? void 0 : _b.remove();
    (_c = document.getElementById("installPromptBg")) === null || _c === void 0 ? void 0 : _c.remove();
}
export function registerPwaGlobals() {
    if (isNativeRuntime()) {
        const noOp = () => { };
        window.reloadForUpdate = noOp;
        window.dismissUpdateNotification = noOp;
        window.closeInstallPrompt = noOp;
        window.installPWAFromPrompt = noOp;
        window.installPWA = noOp;
        window.refreshInstallTabContent = noOp;
        deferredPrompt = null;
        disableNativeInstallUi();
        return;
    }
    window.reloadForUpdate = reloadForUpdate;
    window.dismissUpdateNotification = dismissUpdateNotification;
    window.closeInstallPrompt = closeInstallPrompt;
    window.installPWAFromPrompt = installPWAFromPrompt;
    window.installPWA = installPWA;
    window.refreshInstallTabContent = refreshInstallTabContent;
    registerServiceWorker();
    registerInstallPromptHandlers();
}
export { reloadForUpdate, dismissUpdateNotification, closeInstallPrompt, installPWAFromPrompt, installPWA, refreshInstallTabContent, };
