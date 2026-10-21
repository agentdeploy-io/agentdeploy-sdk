#!/usr/bin/env node

/**
 * Seed demo leads into a locally-running bi-edge engine.
 * ─────────────────────────────────────────────────────────
 * The engine's POST /inbound/sync (X-AD-Sync header = AD_SYNC_SECRET) upserts
 * leads and HONORS caller-supplied stage/status (defaults raw/pending_review),
 * so we can seed leads directly at the exact HITL review state the pipeline
 * would produce after qualifier/researcher/writer — no LLM gateway needed.
 *
 * Seeded state:  stage=researched, status=pending_review, with pitch_subject,
 * pitch_body and emails JSON ([{addr, mx_ok:true}]) pre-filled — i.e. ready to
 * be approved via POST /cmd/data/row and sent via the supervisor `/send`
 * command (which dry-run-logs while settings dryRun=true / BREVO key empty).
 *
 * Usage:
 *   node scripts/seed-engine.mjs [--port 8792] [--sync-secret dev-sync-secret]
 *                                [--base-url http://127.0.0.1:8792]
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = arg("port", "8792");
const SYNC_SECRET = arg("sync-secret", "dev-sync-secret");
const BASE_URL = arg("base-url", `http://127.0.0.1:${PORT}`);

const now = new Date().toISOString();

const leads = [
  {
    key: "GB:northgate-plumbing-ltd",
    country: "GB",
    name: "Northgate Plumbing Ltd",
    city: "Leeds",
    website: "https://northgateplumbing.example",
    website_status: "ok",
    sic: "4322",
    sic_label: "Plumbing, heat and air-conditioning installation",
    emails: JSON.stringify([{ addr: "owner@northgateplumbing.example", mx_ok: true }]),
    source: "seed",
    stage: "researched",
    status: "pending_review",
    classification: JSON.stringify({ tier: "HOT", fit: 0.91, headcount: 12 }),
    research: JSON.stringify({ services: ["boiler installs", "emergency repairs"], techStack: [] }),
    pitch_subject: "Booking more boiler jobs in Leeds without the phone tag",
    pitch_body:
      "Hi Northgate team,\n\nNoticed you cover emergency repairs across Leeds — most 12-person shops we talk to lose a day a week to phone tag.\n\nWe build AI outreach agents that fill the calendar for you. Worth a quick look?\n\nCheers,\nCalla Dev",
    created_at: now,
  },
  {
    key: "DE:ruhr-elektro-gmbh",
    country: "DE",
    name: "Ruhr Elektro GmbH",
    city: "Essen",
    website: "https://ruhr-elektro.example",
    website_status: "ok",
    sic: "4321",
    sic_label: "Electrical installation",
    emails: JSON.stringify([{ addr: "kontakt@ruhr-elektro.example", mx_ok: true }]),
    source: "seed",
    stage: "researched",
    status: "pending_review",
    classification: JSON.stringify({ tier: "WARM", fit: 0.78, headcount: 25 }),
    research: JSON.stringify({ services: ["industrial wiring", "PV installs"], techStack: [] }),
    pitch_subject: "PV install demand in Essen — quick question",
    pitch_body:
      "Hallo Ruhr Elektro team,\n\nPV installs are booming around Essen. Contractors tell us quoting follow-up is where deals die.\n\nOur AI agents chase quotes for you, automatically. Open to a 10-min demo?\n\nViele Grüße,\nCalla Dev",
    created_at: now,
  },
  {
    key: "FR:atelier-mistral-sas",
    country: "FR",
    name: "Atelier Mistral SAS",
    city: "Marseille",
    website: "https://atelier-mistral.example",
    website_status: "none",
    emails: JSON.stringify([{ addr: "bonjour@atelier-mistral.example", mx_ok: true }]),
    source: "seed",
    stage: "researched",
    status: "pending_review",
    classification: JSON.stringify({ tier: "HOT", fit: 0.85, headcount: 8 }),
    research: JSON.stringify({ services: ["joinery", "custom furniture"], techStack: [] }),
    pitch_subject: "Atelier Mistral — more custom joinery clients?",
    pitch_body:
      "Bonjour Atelier Mistral,\n\nYou make beautiful custom joinery but have no website — clients find you by word of mouth only.\n\nWe build AI outreach agents that keep your order book full. Curious?\n\nCordialement,\nCalla Dev",
    created_at: now,
  },
];

const res = await fetch(`${BASE_URL}/inbound/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-AD-Sync": SYNC_SECRET },
  body: JSON.stringify({ leads }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`seed failed: ${res.status} ${JSON.stringify(body)}`);
  console.error(`is bi-edge running at ${BASE_URL}? (npm run dev -- --with-engine)`);
  process.exit(1);
}

console.log(`seeded ${body.accepted} lead(s) into ${BASE_URL} (watermark ${body.watermark}):`);
for (const l of leads) console.log(`  ${l.key}  [${l.stage}/${l.status}]  ${l.name}`);
console.log("\nnext: approve one via POST /cmd/data/row {key, patch:{status:'approved'}}");
console.log("      then POST /cmd/supervisor {message:'/send <key>'} (dry-run by default)");
