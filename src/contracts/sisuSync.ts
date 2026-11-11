/**
 * Persisted SISU sync settings row (historical name retained).
 */

export interface SisuSettings {
  key: "config";
  host: string;
  port: number;
  protocol?: "https" | "http";
  last_connected: string;
  last_sync: string | null;
}
