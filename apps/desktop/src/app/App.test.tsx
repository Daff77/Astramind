import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as ipc from "../lib/ipc";

describe("App foundation shell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders live core health data from typed IPC", async () => {
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
        sqlite_version: "3.49.0",
        fts5_enabled: true,
        fts5_probe_hits: 1,
      },
    });

    render(<App />);
    expect(screen.getByText(/Checking Rust knowledge core/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByText(/Knowledge core online \(windows-x86_64\)/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/3\.49\.0 \(FTS5 enabled\)/i)).toBeInTheDocument();
  });

  it("renders structured ErrorEnvelope when IPC fails", async () => {
    vi.spyOn(ipc, "fetchAppHealth").mockRejectedValue({
      code: "STATE_UNAVAILABLE",
      message: "database offline",
      retryable: false,
      operation_id: null,
      safe_details: null,
    });

    render(<App />);
    await waitFor(() => {
      expect(
        screen.getByText(/STATE_UNAVAILABLE.*database offline/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
