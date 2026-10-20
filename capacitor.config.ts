import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.markrai.fitbaus.trainer",
  appName: "FitBaus Trainer",
  webDir: "www",
  plugins: {
    SystemBars: {
      hidden: true,
      style: "DARK",
      insetsHandling: "css",
    },
  },
};

export default config;
