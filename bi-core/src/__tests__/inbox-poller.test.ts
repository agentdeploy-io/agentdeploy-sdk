import { describe, it, expect, afterEach, vi } from "vitest";
import { startInboxPoller, startProtonPoller, resolveInboxConfig } from "../inbox/imap-poller.js";

describe("resolveInboxConfig", () => {
  it("returns null without credentials", () => {
    expect(resolveInboxConfig({ DATA_DIR: "/tmp" })).toBeNull();
  });

  it("gmail: implicit TLS on 993, verifying certs, INBOX by default", () => {
    const cfg = resolveInboxConfig({
      INBOX_IMAP_HOST: "imap.gmail.com",
      INBOX_IMAP_USER: "agent.replies@gmail.com",
      INBOX_IMAP_PASSWORD: "app-password",
      DATA_DIR: "/data",
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe("gmail");
    expect(cfg!.host).toBe("imap.gmail.com");
    expect(cfg!.port).toBe(993);
    expect(cfg!.secure).toBe(true);
    expect(cfg!.tlsInsecure).toBe(false);
    expect(cfg!.folder).toBe("INBOX");
    expect(cfg!.seenFile).toBe("/data/imap-seen-gmail.json");
    expect(cfg!.intervalMs).toBe(120_000);
    expect(cfg!.webhookUrl).toBe("http://127.0.0.1:8792/inbound-webhook");
  });

  it("gmail: label folder and webhook secret pass through", () => {
    const cfg = resolveInboxConfig({
      INBOX_IMAP_HOST: "imap.gmail.com",
      INBOX_IMAP_USER: "a@gmail.com",
      INBOX_IMAP_PASSWORD: "pw",
      INBOX_IMAP_FOLDER: "Label_AI_AGENT_REPLIES",
      INBOX_WEBHOOK_SECRET: "s3cret",
      EDGE_WEBHOOK_URL: "https://bi-edge.example.workers.dev/inbound-webhook",
    });
    expect(cfg!.folder).toBe("Label_AI_AGENT_REPLIES");
    expect(cfg!.webhookSecret).toBe("s3cret");
    expect(cfg!.webhookUrl).toBe("https://bi-edge.example.workers.dev/inbound-webhook");
  });

  it("legacy proton bridge: localhost 1143, STARTTLS self-signed, legacy fallbacks", () => {
    const cfg = resolveInboxConfig({
      PROTON_IMAP_HOST: "127.0.0.1",
      PROTON_IMAP_PORT: "1143",
      PROTON_IMAP_USER: "agent.miles@gradient3.io",
      PROTON_IMAP_PASSWORD: "bridge-pw",
      PROTON_INBOX_FOLDER: "Folders/agent-miles-outreach",
      PROTON_POLL_INTERVAL_MS: "60000",
      DATA_DIR: "/tmp",
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe("proton-bridge");
    expect(cfg!.host).toBe("127.0.0.1");
    expect(cfg!.port).toBe(1143);
    expect(cfg!.secure).toBe(false);
    expect(cfg!.tlsInsecure).toBe(true); // self-signed Bridge cert
    expect(cfg!.folder).toBe("Folders/agent-miles-outreach");
    expect(cfg!.seenFile).toBe("/tmp/proton-seen.json");
    expect(cfg!.intervalMs).toBe(60_000);
  });

  it("explicit INBOX_IMAP_SECURE / INBOX_TLS_INSECURE override defaults", () => {
    const cfg = resolveInboxConfig({
      INBOX_IMAP_HOST: "imap.gmail.com",
      INBOX_IMAP_PORT: "143",
      INBOX_IMAP_SECURE: "true",
      INBOX_IMAP_USER: "a@gmail.com",
      INBOX_IMAP_PASSWORD: "pw",
    });
    expect(cfg!.secure).toBe(true);
    // gmail provider still verifies certs unless told otherwise
    expect(cfg!.tlsInsecure).toBe(false);
  });
});

describe("startInboxPoller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("is a safe no-op without credentials (no timers, no crash)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    startInboxPoller({ DATA_DIR: "/tmp" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("enables the loop for a gmail inbox (no real connection opened)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    startInboxPoller({
      DATA_DIR: "/tmp",
      INBOX_IMAP_HOST: "imap.gmail.com",
      INBOX_IMAP_USER: "agent.replies@gmail.com",
      INBOX_IMAP_PASSWORD: "app-password",
      INBOX_POLL_INTERVAL_MS: "60000",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("enabled — provider=gmail"));
  });

  it("enables the loop for legacy bridge creds", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    startInboxPoller({
      DATA_DIR: "/tmp",
      PROTON_IMAP_USER: "x@proton.me",
      PROTON_IMAP_PASSWORD: "pw",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("enabled — provider=proton-bridge"));
  });

  it("keeps the legacy startProtonPoller alias working", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    startProtonPoller({
      DATA_DIR: "/tmp",
      INBOX_IMAP_HOST: "imap.gmail.com",
      INBOX_IMAP_USER: "a@gmail.com",
      INBOX_IMAP_PASSWORD: "pw",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("enabled"));
  });
});
