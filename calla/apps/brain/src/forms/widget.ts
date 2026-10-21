/**
 * Embeddable website form — public (no-auth) qualification intake.
 *
 * createFormsApp({ store }) builds a Hono sub-app mounted at /forms and
 * exempted from the brain's bearer auth in server.ts (public BY DESIGN —
 * it is embedded on marketing sites). Three routes:
 *
 *   GET  /forms/widget.js?flow=<flowId>&title=&brand=
 *        A tiny vanilla-JS IIFE (template string, no build step) that injects
 *        a styled minimal form. Fields come from the flow definition — baked
 *        into the script server-side when the flow is known, otherwise fetched
 *        at load from /forms/definition?flow= (choice/yesno/text/email/number
 *        + an optional contact block: name/email/phone).
 *        Client-side required validation; submit → POST /forms/ingest;
 *        success → completion message + booking link / proposed slots when
 *        the run completed and routed. CSS is inline, neutral light theme;
 *        `title`/`brand` params customize the header text. Served with CORS
 *        headers so any site can embed it.
 *
 *   GET  /forms/definition?flow=<flowId>   (public)
 *        {flowId, title, description, fields:[{name, question, type,
 *        options?, required, hint?}]} from the flow store (builtins + customs).
 *        "eircode" fields are exposed as "text" (the widget's input types are
 *        choice/yesno/text/email/number; the runner still matches loosely).
 *
 *   POST /forms/ingest                     (public, CORS *)
 *        {flowId, answers: Record<string,string>, contact?: {name?, email?,
 *        phone?}, session?: string (browser-generated uuid)}
 *        → in-memory per-IP rate limit (10/min → 429)
 *        → lead capture: key `WEB:<email || session>`, name contact.name ||
 *          "Website enquiry", source "website", stage raw / status
 *          pending_review, emails/phones (bi-edge JSON convention) when
 *          present, research {origin:"form", flowId, session}
 *        → startFlow({channel:"form", chatRef:`form:<session>`,
 *          initialAnswers: answers}) — website forms use flow field names
 *          directly, so a complete submission finishes IMMEDIATELY (done)
 *          and scoring/routing/booking proposals run inside the runner
 *        → {ok, leadKey, session, runId, completed, tier?,
 *           summary?: {message, bookingLink?, slots?}}
 *        bookingLink = the rep's scheduling link when routing landed on a
 *        Calendly rep; otherwise proposedSlots are listed for a follow-up
 *        call. CONFIRMATION COMMS ARE THE OPERATOR'S JOB (web UI inbox /
 *        Calla Data) — the widget never emails/texts the visitor.
 *
 *   Audits (agentId "forms"): "form.submitted"; the runner adds the standard
 *   flow.* audits.
 *
 * HARDENING (documented, opt-in):
 *   • FORMS_ALLOWED_ORIGINS — comma-separated origin allowlist; when set,
 *     CORS responses only echo listed origins (unset → "*").
 *   • a per-site token param can be added to the embed URL and checked here
 *     if you need to lock ingestion to known sites (not enforced by default);
 *   • the per-IP rate limit (10/min) is in-memory per process.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import type { CallaStore } from "../store/types.js";
import { syncLeads } from "../lib/engine-client.js";
import { FlowStore } from "../flows/store.js";
import { startFlow } from "../flows/runner.js";
import type { FlowDefinition } from "../flows/types.js";

export interface FormsAppDeps {
  store: CallaStore;
}

/** agentId for every forms cache/audit row. */
export const FORMS_CACHE_AGENT = "forms";

const RATE_LIMIT_PER_MIN = 10;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_ANSWER_LEN = 2000;
const MAX_FIELDS = 60;

// ─── Rate limit (in-memory, per IP) ──────────────────────────────

const hits = new Map<string, number[]>();

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim() || "unknown";
  return c.req.header("x-real-ip") || "unknown";
}

/** True when the IP exceeded RATE_LIMIT_PER_MIN inside the rolling window. */
export function formRateLimited(ip: string, now: number = Date.now()): boolean {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  // Opportunistic map hygiene (single process, tiny footprint).
  if (hits.size > 1000) {
    for (const [k, v] of hits) {
      const live = v.filter((t) => now - t < RATE_WINDOW_MS);
      if (live.length) hits.set(k, live);
      else hits.delete(k);
    }
  }
  return list.length > RATE_LIMIT_PER_MIN;
}

/** Test helper: drop every rate-limit bucket. */
export function clearFormRateLimits(): void {
  hits.clear();
}

// ─── CORS origin policy ──────────────────────────────────────────

function allowedOrigins(): string[] {
  return (process.env.FORMS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Definition mapping ──────────────────────────────────────────

interface PublicField {
  name: string;
  question: string;
  type: "choice" | "yesno" | "text" | "email" | "number";
  options?: string[];
  required: boolean;
  hint?: string;
}

function publicDefinition(def: FlowDefinition): {
  flowId: string;
  title: string;
  description: string;
  fields: PublicField[];
} {
  return {
    flowId: def.id,
    title: def.name,
    description: def.description,
    fields: def.fields.map((f) => ({
      name: f.name,
      question: f.question,
      // The widget renders choice/yesno/text/email/number; eircode is a text
      // input (the runner still applies the loose Eircode matcher on ingest).
      type: f.type === "eircode" ? "text" : f.type,
      ...(f.options ? { options: f.options } : {}),
      required: f.required !== false,
      ...(f.optionalHint ? { hint: f.optionalHint } : {}),
    })),
  };
}

// ─── Widget JS (template string, no build step) ──────────────────

function escapeJsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The embeddable IIFE. BASE/flow/title/brand (and the server-baked definition
 * snapshot, when the flow is known) are JSON.stringify-escaped into the
 * template — no injection. The baked DEF renders the form with zero extra
 * round-trips; the client-side /forms/definition fetch stays as the fallback
 * (and refresh path) for stale embeds.
 */
function buildWidgetJs(
  flowId: string,
  title: string,
  brand: string,
  def: unknown,
): string {
  return `/* Calla forms widget — embed: <script src=".../forms/widget.js?flow=${flowId}" defer><\\/script> */
(function () {
  "use strict";
  var FLOW = ${escapeJsString(flowId)};
  var TITLE = ${escapeJsString(title)};
  var BRAND = ${escapeJsString(brand)};
  var DEF = ${JSON.stringify(def ?? null)};
  var script = document.currentScript;
  var src = (script && script.src) || "";
  var BASE = src.indexOf("/forms/widget.js") >= 0 ? src.split("/forms/widget.js")[0] : "";
  var host = document.createElement("div");
  host.className = "calla-form-host";
  if (script && script.parentNode) script.parentNode.insertBefore(host, script);
  else document.body.appendChild(host);

  var style = document.createElement("style");
  style.textContent = [
    ".calla-form-host{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2933;margin:16px 0}",
    ".calla-form-card{background:#ffffff;border:1px solid #e4e7eb;border-radius:10px;padding:20px;max-width:560px;box-shadow:0 1px 3px rgba(16,24,40,.08)}",
    ".calla-form-card h3{margin:0 0 2px;font-size:18px;color:#101828}",
    ".calla-form-brand{margin:0 0 14px;font-size:12px;color:#667085}",
    ".calla-form-field{margin-bottom:12px}",
    ".calla-form-field label{display:block;font-size:13px;font-weight:600;margin-bottom:4px;color:#344054}",
    ".calla-form-field .calla-form-hint{font-weight:400;color:#98a2b3}",
    ".calla-form-field input,.calla-form-field select,.calla-form-field textarea{width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;color:#101828}",
    ".calla-form-field input:focus,.calla-form-field select:focus{outline:2px solid #1570ef33;border-color:#1570ef}",
    ".calla-form-radios{display:flex;gap:14px;font-size:14px}",
    ".calla-form-radios label{display:inline-flex;align-items:center;gap:5px;font-weight:400}",
    ".calla-form-sep{border:0;border-top:1px solid #eaecf0;margin:16px 0}",
    ".calla-form-submit{background:#1570ef;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer}",
    ".calla-form-submit:disabled{background:#98a2b3;cursor:default}",
    ".calla-form-msg{font-size:13px;margin-top:10px;min-height:16px}",
    ".calla-form-msg.calla-form-error{color:#b42318}",
    ".calla-form-msg.calla-form-ok{color:#067647}",
    ".calla-form-done h3{margin-bottom:8px}",
    ".calla-form-done p{font-size:14px;line-height:1.5}",
    ".calla-form-done a{color:#1570ef;font-weight:600}",
    ".calla-form-slots{font-size:13px;color:#475467;margin:8px 0 0;padding-left:18px}"
  ].join("\\n");
  (document.head || document.documentElement).appendChild(style);

  function session() {
    try {
      var s = window.localStorage.getItem("calla_form_session");
      if (!s) {
        s = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
          : "s-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
        window.localStorage.setItem("calla_form_session", s);
      }
      return s;
    } catch (e) { return "s-" + Date.now(); }
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function field(f) {
    var id = "calla-f-" + f.name;
    var label = el("label", { "for": id, text: f.question + (f.required ? "" : " ") });
    if (!f.required && f.hint) label.appendChild(el("span", { class: "calla-form-hint", text: " — " + f.hint }));
    var input;
    if (f.type === "choice" && f.options) {
      input = el("select", { id: id, name: f.name });
      input.appendChild(el("option", { value: "", text: "Please choose…" }));
      f.options.forEach(function (o) { input.appendChild(el("option", { value: o, text: o })); });
    } else if (f.type === "yesno") {
      input = el("div", { class: "calla-form-radios" });
      ["Yes", "No"].forEach(function (v) {
        var rid = id + "-" + v.toLowerCase();
        var radio = el("input", { type: "radio", id: rid, name: f.name, value: v });
        input.appendChild(el("label", { "for": rid }, [radio, document.createTextNode(" " + v)]));
      });
    } else {
      var t = f.type === "email" ? "email" : f.type === "number" ? "number" : "text";
      input = el("input", { type: t, id: id, name: f.name });
    }
    return el("div", { class: "calla-form-field" }, [label, input]);
  }

  function collect(form, f) {
    if (f.type === "yesno") {
      var checked = form.querySelector('input[name="' + f.name + '"]:checked');
      return checked ? checked.value : "";
    }
    var node = form.querySelector('[name="' + f.name + '"]');
    return node ? String(node.value || "").trim() : "";
  }

  function renderError(message) {
    host.innerHTML = "";
    host.appendChild(el("div", { class: "calla-form-card" }, [
      el("p", { class: "calla-form-msg calla-form-error", text: message })
    ]));
  }

  function renderDone(data) {
    host.innerHTML = "";
    var s = data.summary || {};
    var kids = [el("h3", { text: "Thanks — got it!" })];
    if (s.message) kids.push(el("p", { text: s.message }));
    if (s.bookingLink) {
      kids.push(el("p", {}, [
        document.createTextNode("Book your slot here: "),
        el("a", { href: s.bookingLink, target: "_blank", rel: "noopener", text: s.bookingLink })
      ]));
    }
    if (s.slots && s.slots.length) {
      var list = el("ul", { class: "calla-form-slots" });
      s.slots.slice(0, 5).forEach(function (slot) {
        var d = new Date(slot.start);
        list.appendChild(el("li", { text: d.toLocaleString() }));
      });
      kids.push(el("p", { text: "Proposed times for a follow-up call:" }));
      kids.push(list);
    }
    host.appendChild(el("div", { class: "calla-form-card calla-form-done" }, kids));
  }

  function render(def) {
    host.innerHTML = "";
    var card = el("div", { class: "calla-form-card" });
    var form = el("form", { novalidate: "novalidate" });
    form.appendChild(el("h3", { text: TITLE || def.title || "Enquiry" }));
    if (BRAND) form.appendChild(el("p", { class: "calla-form-brand", text: BRAND }));
    def.fields.forEach(function (f) { form.appendChild(field(f)); });

    form.appendChild(el("hr", { class: "calla-form-sep" }));
    form.appendChild(el("div", { class: "calla-form-field" }, [
      el("label", { "for": "calla-c-name", text: "Your name" }),
      el("input", { type: "text", id: "calla-c-name", name: "__name" })
    ]));
    form.appendChild(el("div", { class: "calla-form-field" }, [
      el("label", { "for": "calla-c-email", text: "Email (so we can reply)" }),
      el("input", { type: "email", id: "calla-c-email", name: "__email" })
    ]));
    form.appendChild(el("div", { class: "calla-form-field" }, [
      el("label", { "for": "calla-c-phone", text: "Phone (optional)" }),
      el("input", { type: "text", id: "calla-c-phone", name: "__phone" })
    ]));

    var submit = el("button", { type: "submit", class: "calla-form-submit", text: "Submit" });
    var msg = el("p", { class: "calla-form-msg" });
    form.appendChild(submit);
    form.appendChild(msg);
    card.appendChild(form);
    host.appendChild(card);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      msg.className = "calla-form-msg";
      msg.textContent = "";
      var answers = {};
      for (var i = 0; i < def.fields.length; i++) {
        var f = def.fields[i];
        var v = collect(form, f);
        if (f.required && !v) {
          msg.className = "calla-form-msg calla-form-error";
          msg.textContent = "Please answer: " + f.question;
          return;
        }
        if (v) answers[f.name] = v;
      }
      var emailNode = form.querySelector('[name="__email"]');
      var email = emailNode ? String(emailNode.value || "").trim() : "";
      if (email && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$/.test(email)) {
        msg.className = "calla-form-msg calla-form-error";
        msg.textContent = "That email address doesn't look right.";
        return;
      }
      var nameNode = form.querySelector('[name="__name"]');
      var phoneNode = form.querySelector('[name="__phone"]');
      var contact = {};
      if (nameNode && nameNode.value.trim()) contact.name = nameNode.value.trim();
      if (email) contact.email = email;
      if (phoneNode && phoneNode.value.trim()) contact.phone = phoneNode.value.trim();

      submit.disabled = true;
      submit.textContent = "Sending…";
      fetch(BASE + "/forms/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: FLOW, answers: answers, contact: contact, session: session() })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
          return data;
        });
      }).then(function (data) {
        renderDone(data);
      }).catch(function (err) {
        submit.disabled = false;
        submit.textContent = "Submit";
        msg.className = "calla-form-msg calla-form-error";
        msg.textContent = err && err.message ? err.message : "Something went wrong — please try again.";
      });
    });
  }

  if (!FLOW) { renderError("Calla form: missing ?flow= parameter."); return; }
  if (DEF && DEF.fields && DEF.fields.length) { render(DEF); return; }
  fetch(BASE + "/forms/definition?flow=" + encodeURIComponent(FLOW))
    .then(function (res) {
      if (!res.ok) throw new Error("unknown flow (" + res.status + ")");
      return res.json();
    })
    .then(function (def) {
      if (!def || !def.fields || !def.fields.length) throw new Error("flow has no fields");
      render(def);
    })
    .catch(function (err) {
      renderError("Calla form could not load: " + (err && err.message ? err.message : err));
    });
})();
`;
}

// ─── App ─────────────────────────────────────────────────────────

export function createFormsApp(deps: FormsAppDeps): Hono {
  const fs = new FlowStore(deps.store);
  const app = new Hono();

  // Public CORS: "*" by default; FORMS_ALLOWED_ORIGINS (comma list) enforces
  // an allowlist when set (non-listed origins get no ACAO header).
  app.use(
    "*",
    cors({
      origin: (origin) => {
        const allow = allowedOrigins();
        if (!allow.length) return "*";
        return allow.includes(origin) ? origin : "";
      },
    }),
  );

  // ── Widget script (public) ─────────────────────────────────────
  app.get("/widget.js", async (c) => {
    const flow = (c.req.query("flow") ?? "").trim();
    const title = (c.req.query("title") ?? "").trim();
    const brand = (c.req.query("brand") ?? "").trim();
    // Bake the definition snapshot when the flow is known (best-effort; the
    // widget falls back to fetching /forms/definition at load).
    let def: ReturnType<typeof publicDefinition> | null = null;
    if (flow) {
      const definition = await fs.getDefinition(flow).catch(() => null);
      if (definition) def = publicDefinition(definition);
    }
    const js = buildWidgetJs(flow, title, brand, def);
    c.header("Content-Type", "application/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(js);
  });

  // ── Flow definition (public) ───────────────────────────────────
  app.get("/definition", async (c) => {
    const flowId = (c.req.query("flow") ?? "").trim();
    if (!flowId) return c.json({ error: "flow query parameter is required" }, 400);
    const def = await fs.getDefinition(flowId);
    if (!def) return c.json({ error: `unknown flow: ${flowId}` }, 404);
    return c.json(publicDefinition(def));
  });

  // ── Ingest (public, rate-limited) ──────────────────────────────
  app.post("/ingest", async (c) => {
    const ip = clientIp(c);
    if (formRateLimited(ip)) {
      return c.json(
        { error: "rate_limited", retryAfterSec: Math.ceil(RATE_WINDOW_MS / 1000) },
        429,
      );
    }

    const body = (await c.req.json().catch(() => null)) as {
      flowId?: unknown;
      answers?: unknown;
      contact?: unknown;
      session?: unknown;
    } | null;
    const flowId = typeof body?.flowId === "string" ? body.flowId.trim() : "";
    if (!flowId) return c.json({ error: "flowId is required" }, 400);
    if (flowId.length > 64) return c.json({ error: "invalid flowId" }, 400);

    const rawAnswers =
      body?.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
        ? (body.answers as Record<string, unknown>)
        : {};
    const answers: Record<string, string> = {};
    let answerCount = 0;
    for (const [k, v] of Object.entries(rawAnswers)) {
      if (answerCount >= MAX_FIELDS) break;
      if (typeof v === "string" || typeof v === "number") {
        answers[k] = String(v).slice(0, MAX_ANSWER_LEN);
        answerCount += 1;
      }
    }

    const contact =
      body?.contact && typeof body.contact === "object"
        ? (body.contact as Record<string, unknown>)
        : {};
    const name =
      typeof contact.name === "string" && contact.name.trim()
        ? contact.name.trim().slice(0, 120)
        : undefined;
    const email =
      typeof contact.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(contact.email.trim())
        ? contact.email.trim().toLowerCase()
        : undefined;
    const phone =
      typeof contact.phone === "string" && contact.phone.trim()
        ? contact.phone.trim().slice(0, 40)
        : undefined;
    const session =
      typeof body?.session === "string" && body.session.trim()
        ? body.session.trim().slice(0, 120)
        : randomUUID();

    const leadKey = `WEB:${email || session}`;

    await deps.store
      .appendAudit({
        agentId: FORMS_CACHE_AGENT,
        kind: "form.submitted",
        entry: {
          flowId,
          leadKey,
          session,
          answers: Object.keys(answers).length,
          hasEmail: Boolean(email),
          hasPhone: Boolean(phone),
          ip,
        },
      })
      .catch((err) => console.warn("[forms] appendAudit(form.submitted) failed:", err));

    // ── Lead capture (best-effort; never blocks the flow) ─────────
    try {
      const res = await syncLeads([
        {
          key: leadKey,
          name: name || "Website enquiry",
          country: "--",
          source: "website",
          stage: "raw",
          status: "pending_review",
          emails: email ? JSON.stringify([{ addr: email, mx_ok: true }]) : null,
          phones: phone ? JSON.stringify([phone]) : null,
          research: JSON.stringify({
            origin: "form",
            flowId,
            session,
            submittedAt: new Date().toISOString(),
          }),
        },
      ]);
      if (!res.ok) {
        console.warn("[forms] lead sync failed (flow continues):", res.error ?? res.status);
      }
    } catch (err) {
      console.warn("[forms] lead sync threw (flow continues):", err);
    }

    // ── Qualification flow (answers use flow field names directly) ─
    const step = await startFlow(deps.store, {
      flowId,
      leadKey,
      channel: "form",
      chatRef: `form:${session}`,
      ...(answerCount ? { initialAnswers: answers } : {}),
    });
    if (step.error !== undefined) {
      return c.json({ error: step.error }, (step.status ?? 400) as any);
    }

    const summary = step.summary;
    return c.json({
      ok: true,
      leadKey,
      session,
      runId: step.run.id,
      completed: Boolean(step.done),
      ...(step.run.tier ? { tier: step.run.tier } : {}),
      summary: {
        message:
          summary?.message ??
          "Thanks — your details are saved. Our team will follow up with you shortly.",
        // bookingLink = the routed rep's scheduling link (Calendly); otherwise
        // proposed slots are listed for a follow-up call. Confirmation comms
        // are the OPERATOR's job (web UI inbox / Calla Data).
        ...(summary?.link ? { bookingLink: summary.link } : {}),
        ...(summary?.slots?.length ? { slots: summary.slots } : {}),
      },
    });
  });

  return app;
}
