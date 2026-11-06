import { describe, it, expect } from "vitest";
import { matchReplyCandidates } from "../reply-match.js";

const sentLeads = [
  {
    key: "test/tom-wait-reply",
    name: "Tom Reply Test",
    emails: ["tomirl2008@gmail.com"],
    subject: "Quick question about your inbox",
  },
];

function item(over: Partial<Record<string, unknown>>): any {
  return {
    messageId: "m1",
    from: "someone@example.com",
    fromName: "",
    subject: "",
    body: "",
    at: "2026-11-05T21:00:00.000Z",
    spam: 0,
    ...over,
  };
}

describe("matchReplyCandidates", () => {
  it("matches a reply from the address we emailed", () => {
    const out = matchReplyCandidates(
      [item({ from: "tomirl2008@gmail.com", subject: "Re: whatever" })],
      sentLeads,
    );
    expect(out).toHaveLength(1);
    expect(out[0].candidates).toEqual(["test/tom-wait-reply"]);
  });

  it("matches case-insensitively on the sender address", () => {
    const out = matchReplyCandidates(
      [item({ from: "TomIRL2008@Gmail.COM", subject: "Re: whatever" })],
      sentLeads,
    );
    expect(out).toHaveLength(1);
    expect(out[0].candidates).toContain("test/tom-wait-reply");
  });

  it("matches a different sender that threads the pitch subject (Re: stripped)", () => {
    const out = matchReplyCandidates(
      [
        item({
          from: "work@otherdomain.com",
          subject: "Re: Quick question about your inbox",
        }),
      ],
      sentLeads,
    );
    expect(out).toHaveLength(1);
    expect(out[0].candidates).toContain("test/tom-wait-reply");
  });

  it("strips nested Re:/Fwd: prefixes before comparing subjects", () => {
    const out = matchReplyCandidates(
      [
        item({
          from: "work@otherdomain.com",
          subject: "Fwd: Re: Quick question about your inbox",
        }),
      ],
      sentLeads,
    );
    expect(out).toHaveLength(1);
    expect(out[0].candidates).toContain("test/tom-wait-reply");
  });

  it("drops unrelated mail (the Monica Tomasso failure case)", () => {
    const out = matchReplyCandidates(
      [
        item({
          from: "monica.tomasso@monicaisystems.com",
          subject: "Re: audit report -ai recommendable",
          body: "Thank you. Kind Regards, Monica",
        }),
      ],
      sentLeads,
    );
    expect(out).toHaveLength(0);
  });

  it("drops newsletters and other people's correspondence", () => {
    const out = matchReplyCandidates(
      [
        item({ from: "team@news.fly.io", subject: "Nov '26 Newsletter" }),
        item({ from: "mailer@malt.com", subject: "Confirm your email address" }),
        item({
          from: "cloud-success@grafana.com",
          subject: "7 days left in your Grafana Cloud trial",
        }),
      ],
      sentLeads,
    );
    expect(out).toHaveLength(0);
  });

  it("does not double-count a lead matched by both address and subject", () => {
    const out = matchReplyCandidates(
      [
        item({
          from: "tomirl2008@gmail.com",
          subject: "Re: Quick question about your inbox",
        }),
      ],
      sentLeads,
    );
    expect(out).toHaveLength(1);
    expect(out[0].candidates).toEqual(["test/tom-wait-reply"]);
  });

  it("matches multiple candidate leads when the subject threads several pitches", () => {
    const leads = [
      { key: "a", name: "A", emails: ["a@x.com"], subject: "Hello A" },
      { key: "b", name: "B", emails: ["b@x.com"], subject: "Hello B" },
    ];
    const out = matchReplyCandidates(
      [item({ from: "z@x.com", subject: "Re: Hello A and then Hello B" })],
      leads,
    );
    expect(out).toHaveLength(1);
    expect(out[0].candidates.sort()).toEqual(["a", "b"]);
  });

  it("ignores subject matching when the lead has no pitch subject set", () => {
    const leads = [
      { key: "a", name: "A", emails: ["a@x.com"], subject: "" },
    ];
    const out = matchReplyCandidates(
      [item({ from: "z@x.com", subject: "Re: anything" })],
      leads,
    );
    expect(out).toHaveLength(0);
  });
});
