import { describe, it, expect, afterEach, vi } from "vitest";
import { startProtonPoller } from "../proton/inbox-poller.js";

describe("startProtonPoller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("is a safe no-op without credentials (no timers, no crash)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    startProtonPoller({ DATA_DIR: "/tmp" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("enables the loop when credentials are present", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    // Timers are unref'd and never advanced — this only exercises the
    // enablement path without opening a real IMAP connection.
    startProtonPoller({
      DATA_DIR: "/tmp",
      PROTON_IMAP_USER: "x@proton.me",
      PROTON_IMAP_PASSWORD: "pw",
      PROTON_INBOX_FOLDER: "INBOX",
      PROTON_POLL_INTERVAL_MS: "60000",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("enabled"));
  });
});
