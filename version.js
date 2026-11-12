// Centralized version number for the app
// Update this value when releasing a new version
const APP_VERSION = "1.0.0";

// Make version globally accessible
if (typeof window !== 'undefined') {
  window.APP_VERSION = APP_VERSION;
}
