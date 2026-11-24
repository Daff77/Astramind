import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as ipc from "../lib/ipc";

describe("App desktop shell & IPC error boundaries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("renders onboarding when no vault is open and keeps future modules explicitly disabled", async () => {
    vi.spyOn(ipc, "fetchAppHealth").mockResolvedValue({
      app_name: "Personal Brain",
      core_version: "0.1.0",
      platform: "windows-x86_64",
      paths: {
        app_data_dir: "C:\\Users\\test\\AppData\\Local\\PersonalBrain",
        registry_db:
          "C:\\Users\\test\\AppData\\Local\\PersonalBrain\\registry.sqlite",
        vaults_dir: "C:\\Users\\test\\AppData\\Local\\PersonalBrain\\vaults",
      },
      sqlite: {
        sqlite_version: "3.49.1",
        fts5_enabled: true,
        fts5_probe_hits: 1,
      },
    });
    vi.spyOn(ipc, "listVaults").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Open or create a local Markdown vault/i }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /Universe \(Unavailable in Phase 4\)/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /AI Brain \(Unavailable in Phase 4\)/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Memory \(Unavailable in Phase 4\)/i }),
    ).toBeDisabled();
  });

  it("surfaces structured ErrorEnvelope and rejects unknown ErrorCodes", async () => {
    vi.spyOn(ipc, "fetchAppHealth").mockRejectedValue({
      code: "STATE_UNAVAILABLE",
      message: "database offline",
      retryable: false,
      operation_id: null,
      safe_details: null,
    });
    vi.spyOn(ipc, "listVaults").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getAllByText(/STATE_UNAVAILABLE.*database offline/i).length,
      ).toBeGreaterThan(0);
    });

    expect(ipc.parseErrorCode("CONFLICT")).toBe("CONFLICT");
    expect(ipc.parseErrorCode("UNKNOWN_FAKE_CODE")).toBe("IO_FAILED");
  });
});
