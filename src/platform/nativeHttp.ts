import { CapacitorHttp } from "@capacitor/core";
import type { SisuHttpRequest, SisuHttpResponse } from "./sisuHttp.js";

export async function nativeSisuRequest(request: SisuHttpRequest): Promise<SisuHttpResponse> {
  const response = await CapacitorHttp.request({
    url: request.url,
    method: request.method,
    headers: { "Content-Type": "application/json" },
    data: request.data,
    connectTimeout: request.timeoutMs,
    readTimeout: request.timeoutMs,
  });
  const data = response.data;
  const text = typeof data === "string" ? data : data == null ? "" : JSON.stringify(data);
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    data,
    text,
  };
}
