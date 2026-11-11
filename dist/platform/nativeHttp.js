import { CapacitorHttp } from "@capacitor/core";
export async function nativeSisuRequest(request) {
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
