import { invoke } from "@tauri-apps/api/core";
import type { AppHealthDto, ErrorEnvelope } from "./contracts";

export function normalizeIpcError(err: unknown): ErrorEnvelope {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err
  ) {
    const candidate = err as Partial<ErrorEnvelope>;
    return {
      code: candidate.code ?? "IO_FAILED",
      message: String(candidate.message ?? "Unknown core error"),
      retryable: Boolean(candidate.retryable),
      operation_id: candidate.operation_id ?? null,
      safe_details: candidate.safe_details ?? null,
    };
  }
  return {
    code: "IO_FAILED",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
    operation_id: null,
    safe_details: null,
  };
}

export async function fetchAppHealth(): Promise<AppHealthDto> {
  try {
    return await invoke<AppHealthDto>("app_health");
  } catch (err) {
    throw normalizeIpcError(err);
  }
}
