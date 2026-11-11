import { isNativeRuntime } from "./runtime.js";

export interface SisuHttpRequest {
  url: string;
  method: "GET" | "POST";
  data?: unknown;
  timeoutMs: number;
}

export interface SisuHttpResponse {
  ok: boolean;
  status: number;
  data: any;
  text: string;
}

function parseResponseText(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function webSisuRequest(request: SisuHttpRequest): Promise<SisuHttpResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: request.data === undefined ? undefined : JSON.stringify(request.data),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      data: parseResponseText(text),
      text,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function requestSisu(request: SisuHttpRequest): Promise<SisuHttpResponse> {
  if (!isNativeRuntime()) return webSisuRequest(request);
  if (request.url.toLowerCase().startsWith("http://")) {
    throw new Error(
      "Native HTTP SISU endpoints are blocked by the app's secure transport configuration. Use HTTPS; FitBaus Trainer does not enable broad cleartext exceptions."
    );
  }
  const { nativeSisuRequest } = await import("./nativeHttp.js");
  return nativeSisuRequest(request);
}
