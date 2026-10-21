/**
 * Flows HTTP surface — createFlowsApp({ store }) builds a Hono sub-app
 * mounted at /flows (behind the brain's bearer auth; no webhook paths).
 *
 * Route map:
 *   GET    /definitions                builtins (code) + customs (store), merged
 *   POST   /definitions                create a CUSTOM flow (409 on dup/builtin id)
 *   GET    /definitions/:id
 *   PUT    /definitions/:id            custom only (builtin → 400 "versioned in code")
 *   DELETE /definitions/:id            custom only
 *   POST   /runs                       start → { run, prompt } (or done+summary)
 *   GET    /runs?status=&limit=        capped index (newest first)
 *   GET    /runs/:id
 *   POST   /runs/:id/answer  {text}    → { run, prompt?, done?, summary?, matched? }
 *   POST   /runs/:id/cancel  {reason?} → audit flow.abandoned
 *   POST   /runs/:id/book    {slotStart, attendee?}
 *                                      confirm a proposed slot with the routed
 *                                      rep via the booking module (in-process);
 *                                      calendly reps → 400 + { link } (share the
 *                                      scheduling link; the webhook records it)
 *   GET    /routing/rules              list RoutingRules
 *   POST   /routing/rules              create (first match wins; rep must exist)
 *   DELETE /routing/rules/:id
 *
 * Every mutation is hash-chain audited under agentId "flows".
 */
import { Hono } from "hono";
import { z } from "zod";
import type { CallaStore } from "../store/types.js";
import {
  createRoutingRule,
  deleteRoutingRule,
  listRoutingRules,
  seedRoutingRules,
} from "../booking/routing.js";
import { FlowStore, validateFlowDefinition } from "./store.js";
import {
  answerFlow,
  bookRunSlot,
  cancelFlow,
  startFlow,
} from "./runner.js";
import type { FlowStepResult } from "./types.js";

export interface FlowsAppDeps {
  store: CallaStore;
}

const CHANNELS = ["rest", "social", "whatsapp", "form", "leadform"] as const;

const startRunSchema = z.object({
  flowId: z.string().min(1).max(64),
  leadKey: z.string().max(200).optional(),
  channel: z.enum(CHANNELS).default("rest"),
  chatRef: z.string().max(200).optional(),
  initialAnswers: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

const answerSchema = z.object({
  text: z.string().min(1).max(4000),
});

const cancelSchema = z.object({
  reason: z.string().max(300).optional(),
});

const bookSchema = z.object({
  slotStart: z.string().min(1),
  attendee: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().max(200).optional(),
      phone: z.string().max(40).optional(),
    })
    .optional(),
});

/** Split a FlowStepResult into an HTTP response body/status. */
function stepResponse(c: any, result: FlowStepResult) {
  if (result.error !== undefined) {
    return c.json({ error: result.error }, (result.status ?? 400) as any);
  }
  return c.json({
    run: result.run,
    ...(result.prompt ? { prompt: result.prompt } : {}),
    ...(result.done ? { done: true } : {}),
    ...(result.matched !== undefined ? { matched: result.matched } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
  });
}

export function createFlowsApp(deps: FlowsAppDeps): Hono {
  const fs = new FlowStore(deps.store);
  const app = new Hono();

  // ── Definitions ───────────────────────────────────────────────

  app.get("/definitions", async (c) => {
    const definitions = await fs.listDefinitions();
    return c.json({
      definitions,
      total: definitions.length,
      builtin: definitions.filter((d) => FlowStore.isBuiltin(d.id)).length,
    });
  });

  app.post("/definitions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const [def, err] = await fs.createDefinition(body);
    if (!def) {
      const status = err?.startsWith("duplicate") ? 409 : 400;
      return c.json({ error: err ?? "invalid definition" }, status as 409 | 400);
    }
    await fs.audit("flow.definition_created", { flowId: def.id, fields: def.fields.length });
    return c.json({ definition: def }, 201);
  });

  app.get("/definitions/:id", async (c) => {
    const id = c.req.param("id");
    const def = await fs.getDefinition(id);
    if (!def) return c.json({ error: `unknown flow: ${id}` }, 404);
    return c.json({ definition: def, builtin: FlowStore.isBuiltin(id) });
  });

  app.put("/definitions/:id", async (c) => {
    const id = c.req.param("id");
    if (FlowStore.isBuiltin(id)) {
      return c.json({ error: "builtin flows are versioned in code" }, 400);
    }
    const body = await c.req.json().catch(() => null);
    const [def, err] = await fs.updateDefinition(id, body);
    if (!def) {
      const status = err?.startsWith("not-found") ? 404 : 400;
      return c.json({ error: err ?? "invalid definition" }, status as 404 | 400);
    }
    await fs.audit("flow.definition_updated", { flowId: def.id, fields: def.fields.length });
    return c.json({ definition: def });
  });

  app.delete("/definitions/:id", async (c) => {
    const id = c.req.param("id");
    if (FlowStore.isBuiltin(id)) {
      return c.json({ error: "builtin flows are versioned in code" }, 400);
    }
    const [removed, err] = await fs.deleteDefinition(id);
    if (!removed) {
      const status = err?.startsWith("not-found") ? 404 : 400;
      return c.json({ error: err ?? "delete failed" }, status as 404 | 400);
    }
    await fs.audit("flow.definition_deleted", { flowId: removed.id });
    return c.json({ ok: true, definition: removed });
  });

  // ── Runs ──────────────────────────────────────────────────────

  app.post("/runs", async (c) => {
    const parsed = startRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const input = parsed.data;
    const result = await startFlow(deps.store, {
      flowId: input.flowId,
      ...(input.leadKey ? { leadKey: input.leadKey } : {}),
      channel: input.channel,
      ...(input.chatRef ? { chatRef: input.chatRef } : {}),
      ...(input.initialAnswers ? { initialAnswers: input.initialAnswers } : {}),
    });
    if (result.error !== undefined) {
      return c.json({ error: result.error }, (result.status ?? 400) as any);
    }
    return c.json(
      {
        run: result.run,
        ...(result.prompt ? { prompt: result.prompt } : {}),
        ...(result.done ? { done: true } : {}),
        ...(result.summary ? { summary: result.summary } : {}),
      },
      201,
    );
  });

  app.get("/runs", async (c) => {
    const status = c.req.query("status");
    if (status && !["active", "completed", "cancelled"].includes(status)) {
      return c.json({ error: `invalid status: ${status}` }, 400);
    }
    const limitRaw = Number(c.req.query("limit") ?? "");
    const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.trunc(limitRaw), 200) : 50;
    const index = await fs.listIndex();
    const filtered = status ? index.filter((e) => e.status === status) : index;
    const runs = filtered.slice(0, limit);
    return c.json({ runs, total: runs.length, filteredFrom: index.length });
  });

  app.get("/runs/:id", async (c) => {
    const run = await fs.getRun(c.req.param("id"));
    if (!run) return c.json({ error: `unknown run: ${c.req.param("id")}` }, 404);
    return c.json({ run });
  });

  app.post("/runs/:id/answer", async (c) => {
    const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const result = await answerFlow(deps.store, c.req.param("id"), parsed.data.text);
    return stepResponse(c, result);
  });

  app.post("/runs/:id/cancel", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = body == null ? { success: true as const, data: {} } : cancelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const result = await cancelFlow(deps.store, c.req.param("id"), parsed.data.reason);
    if (result.error !== undefined) {
      return c.json({ error: result.error }, (result.status ?? 400) as any);
    }
    return c.json({ ok: true, run: result.run });
  });

  app.post("/runs/:id/book", async (c) => {
    const parsed = bookSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const result = await bookRunSlot(
      deps.store,
      c.req.param("id"),
      parsed.data.slotStart,
      parsed.data.attendee,
    );
    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.link ? { link: result.link } : {}) },
        result.status as any,
      );
    }
    return c.json(
      {
        appointment: result.appointment,
        ...(result.link ? { link: result.link } : {}),
        run: result.run,
      },
      201,
    );
  });

  // ── Routing rules ─────────────────────────────────────────────

  app.get("/routing/rules", async (c) => {
    const rules = await listRoutingRules(deps.store);
    return c.json({ rules, total: rules.length });
  });

  app.post("/routing/rules", async (c) => {
    const body = await c.req.json().catch(() => null);
    const [rule, err] = await createRoutingRule(deps.store, body);
    if (!rule) {
      const status = err?.startsWith("duplicate") ? 409 : 400;
      return c.json({ error: err ?? "invalid rule" }, status as 409 | 400);
    }
    await fs.audit("flow.routing_rule_created", {
      ruleId: rule.id,
      repId: rule.repId,
      match: rule.match,
    });
    return c.json({ rule }, 201);
  });

  app.delete("/routing/rules/:id", async (c) => {
    const id = c.req.param("id");
    const removed = await deleteRoutingRule(deps.store, id);
    if (!removed) return c.json({ error: `unknown routing rule: ${id}` }, 404);
    await fs.audit("flow.routing_rule_deleted", { ruleId: removed.id, repId: removed.repId });
    return c.json({ ok: true, rule: removed });
  });

  return app;
}

/** Idempotent bootstrap seeding (server.ts): defs key + empty routing rules. */
export async function seedFlows(store: CallaStore): Promise<void> {
  const fs = new FlowStore(store);
  await fs.seed();
  await seedRoutingRules(store);
}

/** Re-exported for integrators. */
export { validateFlowDefinition };
