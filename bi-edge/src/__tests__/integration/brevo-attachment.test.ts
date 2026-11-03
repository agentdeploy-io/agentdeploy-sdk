import { describe, it, expect, vi, afterEach } from "vitest";

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: "msg-att-1" }), { status: 200 }));
vi.stubGlobal("fetch", fetchMock);
afterEach(() => {
  vi.clearAllMocks();
});

import { sendViaBrevo } from "../../agents/outreach.js";

const env = { BREVO_API_KEY: "k", BREVO_SENDER_EMAIL: "agent.miles@gradient3.io", BRAND_NAME: "Agent Miles" };

describe("sendViaBrevo attachment wire format", () => {
  it("sends attachments as an array of {name, content} objects", async () => {
    const icsB64 = Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").toString("base64");
    const res = await sendViaBrevo(
      ["a@example.com", "b@example.com"],
      "Test Co",
      "Calendar invite",
      "<p>hi</p>",
      env,
      { attachment: { filename: "meeting-2.ics", contentBase64: icsB64 } },
    );
    expect(res.messageId).toBe("msg-att-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.brevo.com/v3/smtp/email");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual([
      { email: "a@example.com", name: "Test Co" },
      { email: "b@example.com", name: "Test Co" },
    ]);
    // Brevo rejects the {filename: base64} map with 400 invalid_parameter —
    // the payload must be the array form.
    expect(body.attachment).toEqual([{ name: "meeting-2.ics", content: icsB64 }]);
  });

  it("omits the attachment field entirely when none is given", async () => {
    await sendViaBrevo("a@example.com", "Test Co", "Plain", "<p>hi</p>", env);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.attachment).toBeUndefined();
  });
});
