interface CapacitorRuntimeBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function getCapacitorBridge(): CapacitorRuntimeBridge | undefined {
  return (globalThis as any).Capacitor as CapacitorRuntimeBridge | undefined;
}

export function isNativeRuntime(): boolean {
  const bridge = getCapacitorBridge();
  if (!bridge) return false;
  if (typeof bridge.isNativePlatform === "function") {
    return bridge.isNativePlatform();
  }
  const platform = typeof bridge.getPlatform === "function" ? bridge.getPlatform() : "web";
  return platform === "android" || platform === "ios";
}

export function getRuntimePlatform(): "android" | "ios" | "web" {
  const platform = getCapacitorBridge()?.getPlatform?.();
  return platform === "android" || platform === "ios" ? platform : "web";
}

async function hideSystemBars(): Promise<void> {
  const { SystemBars } = await import("@capacitor/core");
  await SystemBars.hide();
}

function listenForAppResume(onResume: () => void): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onResume();
  });

  const capacitor = getCapacitorBridge() as CapacitorRuntimeBridge & {
    addListener?: (
      pluginName: string,
      eventName: string,
      callback: (state: { isActive?: boolean }) => void
    ) => void;
  };
  capacitor.addListener?.("App", "appStateChange", (state) => {
    if (state?.isActive) onResume();
  });
}

export function applyRuntimeDocumentState(): void {
  if (!isNativeRuntime()) return;
  document.documentElement.classList.add("capacitor-native");
  const hideBars = () => {
    void hideSystemBars().catch(() => {});
  };
  hideBars();
  listenForAppResume(hideBars);
}
