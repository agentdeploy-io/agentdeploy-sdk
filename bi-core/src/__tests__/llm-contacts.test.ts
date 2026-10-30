import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mergeLlmContacts,
  extractContactsLlm,
  enrichContacts,
} from "../pipeline/behaviors.js";
import { extractEmails } from "../extraction.js";
import { emptyDrops } from "../pipeline/types.js";
import type { VerticalPack, Candidate } from "../pipeline/types.js";
import type { ExtractedEmail } from "../types.js";
import type { SmartFetchResult } from "../pipeline/renderer.js";

// ── mergeLlmContacts (pure) ────────────────────────────────────────────────

const baseEmails = (extra: ExtractedEmail[] = []): ExtractedEmail[] => [
  { address: "info@acme.co.uk", kind: "role", mx_ok: true },
  ...extra,
];

describe("mergeLlmContacts", () => {
  it("adds LLM addresses the regex missed, dedupes case-insensitively", () => {
    const merged = mergeLlmContacts(baseEmails(), {
      emails: [
        { address: "INFO@acme.co.uk" }, // dup of base (different case)
        { address: "sales@acme.co.uk" },
      ],
    });
    expect(merged.emails.map((e) => e.address)).toEqual([
      "info@acme.co.uk",
      "sales@acme.co.uk",
    ]);
  });

  it("named non-role address becomes the contact person (personal)", () => {
    const merged = mergeLlmContacts(baseEmails(), {
      emails: [{ address: "tom@acme.co.uk", name: "Tom Smith", role: "Founder" }],
    });
    const tom = merged.emails.find((e) => e.address === "tom@acme.co.uk")!;
    expect(tom.kind).toBe("personal");
    expect(merged.contactName).toBe("Tom Smith");
    expect(merged.contactRole).toBe("Founder");
  });

  it("named role-prefix address stays role, no contact person", () => {
    const merged = mergeLlmContacts(baseEmails(), {
      emails: [{ address: "info@other.co.uk", name: "The Info Box", role: "General" }],
    });
    const e = merged.emails.find((x) => x.address === "info@other.co.uk")!;
    expect(e.kind).toBe("role");
    expect(merged.contactName).toBeUndefined();
  });

  it("unnamed LLM address is conservative role", () => {
    const merged = mergeLlmContacts([], { emails: [{ address: "hello@x.co.uk" }] });
    expect(merged.emails[0]).toMatchObject({ address: "hello@x.co.uk", kind: "role", mx_ok: null });
  });

  it("first named contact wins", () => {
    const merged = mergeLlmContacts([], {
      emails: [
        { address: "ann@x.co.uk", name: "Ann Lee", role: "Director" },
        { address: "bob@x.co.uk", name: "Bob Ray", role: "Sales" },
      ],
    });
    expect(merged.contactName).toBe("Ann Lee");
  });
});

// ── extractContactsLlm (fetch stub) ────────────────────────────────────────

const LLM_URL = "https://llm.test/v1/chat/completions";

function llmResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const pagesWithText = (text: string) => [{ url: "https://acme.co.uk", html: `<html><body>${text}</body></html>`, text }];

describe("extractContactsLlm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses contacts from the LLM JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        llmResponse({
          emails: [{ address: "tom@acme.co.uk", name: "Tom Smith", role: "Founder" }],
          phones: ["+44 20 7946 0123"],
        }),
      ),
    );
    const out = await extractContactsLlm(
      { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" },
      pagesWithText("Contact us for a quote. " + "x".repeat(120)),
    );
    expect(out).toEqual({
      emails: [{ address: "tom@acme.co.uk", name: "Tom Smith", role: "Founder" }],
      phones: ["+44 20 7946 0123"],
    });
  });

  it("filters invented/malformed addresses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        llmResponse({
          emails: [
            { address: "not-an-email" },
            { address: "tom@acme.co.uk", name: "Tom" },
          ],
        }),
      ),
    );
    const out = await extractContactsLlm(
      { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" },
      pagesWithText("Contact us for a quote. " + "x".repeat(120)),
    );
    expect(out!.emails).toEqual([{ address: "tom@acme.co.uk", name: "Tom", role: undefined }]);
  });

  it("strips leading percent-escapes (mailto:%20x@y artifacts)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        llmResponse({
          emails: [{ address: "%20chris@digitalb2bservices.com" }],
        }),
      ),
    );
    const out = await extractContactsLlm(
      { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" },
      pagesWithText("Contact us for a quote. " + "x".repeat(120)),
    );
    expect(out!.emails).toEqual([{ address: "chris@digitalb2bservices.com", name: undefined, role: undefined }]);
  });

  it("returns null when pages have no usable text (no LLM call)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await extractContactsLlm(
      { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" },
      pagesWithText("Short."),
    );
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when the LLM is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("gateway down"); }));
    const out = await extractContactsLlm(
      { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" },
      pagesWithText("Contact us for a quote. " + "x".repeat(120)),
    );
    expect(out).toBeNull();
  });

  it("parses a page-level contact person (no named email)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        llmResponse({
          emails: [{ address: "info@acme.co.uk" }],
          contact: { name: "Dr Isabella Parkes", role: "Dentist" },
        }),
      ),
    );
    const out = await extractContactsLlm(
      { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" },
      pagesWithText("Contact us for a quote. " + "x".repeat(120)),
    );
    expect(out!.contact).toEqual({ name: "Dr Isabella Parkes", role: "Dentist" });
  });

  it("a contact person alone is a valid result (no emails/phones)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => llmResponse({ contact: { name: "Sam Owner", role: "Director" } })),
    );
    const out = await extractContactsLlm(
      { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" },
      pagesWithText("Contact us for a quote. " + "x".repeat(120)),
    );
    expect(out).toEqual({ emails: [], phones: [], contact: { name: "Sam Owner", role: "Director" } });
  });
});

// ── enrichContacts: LLM pass wired in ──────────────────────────────────────

function pack(over: Partial<VerticalPack> = {}): VerticalPack {
  return {
    id: "v-t", name: "T", icp: "test", countries: ["uk"],
    dorks: [], requireWebsite: true, useRegistry: true, llmEnrich: true,
    mxGuess: false, minScore: 50, perCountryLimit: 5,
    ...over,
  };
}

const HOME_TEXT =
  "Acme Design — web design agency. Call us on +44 20 7946 0500. " +
  "Email the team at info@acme.co.uk for a free quote. " +
  "Our founder Tom Smith is happy to answer any questions personally. ";

function home(): SmartFetchResult {
  return { page: { url: "https://acme.co.uk", html: `<html><body>${HOME_TEXT}</body></html>`, text: HOME_TEXT }, rendered: false };
}

const candidate: Candidate = { key: "uk-acme", country: "uk", name: "Acme Design", source: "test", website: "https://acme.co.uk" };

describe("enrichContacts LLM pass", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges LLM contacts: name, personal kind, phone; no duplicate of regex email", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === LLM_URL) {
        return llmResponse({
          emails: [{ address: "info@acme.co.uk", name: "Front Desk" }, { address: "tom@acme.co.uk", name: "Tom Smith", role: "Founder" }],
          phones: ["+44 20 7946 0123"],
        });
      }
      // contact subpages + robots/sitemap
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const lead = await enrichContacts(
      { pack: pack(), country: "uk", env: { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" }, candidate, drops: emptyDrops() },
      candidate,
      home(),
    );

    const addrs = (lead.emails ?? []).map((e) => e.address);
    expect(addrs.filter((a) => a === "info@acme.co.uk")).toHaveLength(1); // no dup
    const tom = (lead.emails ?? []).find((e) => e.address === "tom@acme.co.uk")!;
    expect(tom).toBeDefined();
    expect(tom.kind).toBe("personal");
    expect(lead.contact_name).toBe("Tom Smith");
    expect(lead.contact_role).toBe("Founder");
    expect(lead.phones).toContain("+44 20 7946 0123");
    expect(lead.phones).toContain("+44 20 7946 0500"); // regex-found one kept
  });

  it("falls back to the page-level contact person when no email is named", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === LLM_URL) {
        return llmResponse({
          emails: [{ address: "info@acme.co.uk" }],
          contact: { name: "Dr Isabella Parkes", role: "Dentist" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const lead = await enrichContacts(
      { pack: pack(), country: "uk", env: { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" }, candidate, drops: emptyDrops() },
      candidate,
      home(),
    );

    expect(lead.contact_name).toBe("Dr Isabella Parkes");
    expect(lead.contact_role).toBe("Dentist");
  });

  it("skips the LLM pass when llmEnrich is off", async () => {
    const fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    const lead = await enrichContacts(
      { pack: pack({ llmEnrich: false }), country: "uk", env: { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1" }, candidate, drops: emptyDrops() },
      candidate,
      home(),
    );

    expect(lead.contact_name).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalledWith(LLM_URL, expect.anything());
  });
});

// ── regex path: percent-escape artifacts ───────────────────────────────────

describe("extractEmails", () => {
  it("strips leading percent-escapes from plain-text matches", () => {
    const out = extractEmails(
      '<a href="mailto:%20chris@digitalb2bservices.com">chris@digitalb2bservices.com</a>',
      "write to %20chris@digitalb2bservices.com today",
    );
    expect(out).toContain("chris@digitalb2bservices.com");
    expect(out).not.toContain("%20chris@digitalb2bservices.com");
  });
});
