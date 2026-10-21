#!/usr/bin/env node

/**
 * Provision the Telnyx TeXML app + number for the Calla voice line (B1).
 * ─────────────────────────────────────────────────────────────────────────
 * Real Telnyx REST (Bearer API key), idempotent — safe to run on every
 * deploy:
 *   1. Finds or creates the `calla-voice-<digits>` TeXML application:
 *        - voice_url        = <CALLA_EDGE_URL>/telnyx/inbound (GET)
 *                              (consent Say + <Stream> → /telnyx/stream)
 *        - status_callback  = <CALLA_EDGE_URL>/telnyx/status (POST)
 *                              (Ed25519-verified; escalation speak+hangup)
 *   2. Assigns the practice number to that application (PATCH the number's
 *      connection_id). The number must already exist in the account
 *      (order it in Mission Control → Numbers first — the account has no
 *      inventory of its own to provision into automatically).
 *   3. Finds or creates the `calla-voice-dialer` Call Control App with
 *      webhook_event_url = <CALLA_EDGE_URL>/telnyx/status. Outbound dials
 *      (escalation) are rejected by Telnyx unless the connection has a
 *      valid webhook URL, and credential connections are read-only — so
 *      the dialer is a dedicated Call Control App. Its id is the worker's
 *      TELNYX_CONNECTION_ID.
 *
 * The deployed edge worker MUST already serve /telnyx/inbound publicly
 * before the number is called.
 *
 * Usage:
 *   node scripts/provision-telnyx.mjs \
 *     --api-key $TELNYX_API_KEY --number +3531... \
 *     --edge-url https://calla-edge.example.workers.dev
 *
 * Values also come from env: TELNYX_API_KEY / TELNYX_DEFAULT_NUMBER /
 * CALLA_EDGE_URL.
 */

const API_BASE = "https://api.telnyx.com/v2";

function arg(flag, envName, fallback) {
  const i = process.argv.indexOf(`--${flag}`);
  return (i !== -1 && process.argv[i + 1]) || process.env[envName] || fallback;
}

const API_KEY = arg("api-key", "TELNYX_API_KEY", "");
const NUMBER = arg("number", "TELNYX_DEFAULT_NUMBER", "");
const EDGE_URL = arg("edge-url", "CALLA_EDGE_URL", "").replace(/\/+$/, "");

for (const [label, value] of [
  ["--api-key / TELNYX_API_KEY", API_KEY],
  ["--number / TELNYX_DEFAULT_NUMBER", NUMBER],
  ["--edge-url / CALLA_EDGE_URL", EDGE_URL],
]) {
  if (!value) {
    console.error(`missing ${label}`);
    process.exit(1);
  }
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail =
      data?.errors?.[0]?.detail ?? data?.errors?.[0]?.title ?? text.slice(0, 300);
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return data;
}

// 1) Find or create the TeXML application.
const digits = NUMBER.replace(/\D/g, "");
const appName = `calla-voice-${digits}`;
const list = await api("GET", `/texml_applications?per_page=100`);
const existing = (list.data ?? []).find((a) => a.friendly_name === appName);

let appId;
if (existing) {
  appId = existing.id;
  const updated = await api("PATCH", `/texml_applications/${appId}`, {
    friendly_name: appName,
    voice_url: `${EDGE_URL}/telnyx/inbound`,
    voice_method: "GET",
    status_callback: `${EDGE_URL}/telnyx/status`,
    status_callback_method: "POST",
  });
  appId = updated.data?.id ?? appId;
  console.log(`[provision-telnyx] updated TeXML app ${appName} (${appId})`);
} else {
  const created = await api("POST", "/texml_applications", {
    friendly_name: appName,
    voice_url: `${EDGE_URL}/telnyx/inbound`,
    voice_method: "GET",
    status_callback: `${EDGE_URL}/telnyx/status`,
    status_callback_method: "POST",
  });
  appId = created.data?.id;
  if (!appId) throw new Error("TeXML application created but no id returned");
  console.log(`[provision-telnyx] created TeXML app ${appName} (${appId})`);
}

console.log(`[provision-telnyx] voice_url       → ${EDGE_URL}/telnyx/inbound (GET)`);
console.log(`[provision-telnyx] status_callback → ${EDGE_URL}/telnyx/status (POST)`);

// 2) Outbound dialer: a dedicated Call Control App (credential connections
//    are read-only; dials need a connection with a valid webhook URL).
const dialerName = "calla-voice-dialer";
const dialers = await api("GET", `/call_control_applications?per_page=100`);
const dialer = (dialers.data ?? []).find((a) => a.application_name === dialerName);
let dialerId;
if (dialer) {
  const updated = await api("PATCH", `/call_control_applications/${dialer.id}`, {
    application_name: dialerName,
    webhook_event_url: `${EDGE_URL}/telnyx/status`,
    webhook_api_version: "2",
  });
  dialerId = updated.data?.id ?? dialer.id;
  console.log(`[provision-telnyx] updated Call Control App ${dialerName} (${dialerId})`);
} else {
  const created = await api("POST", "/call_control_applications", {
    application_name: dialerName,
    webhook_event_url: `${EDGE_URL}/telnyx/status`,
    webhook_api_version: "2",
  });
  dialerId = created.data?.id;
  if (!dialerId) throw new Error("Call Control App created but no id returned");
  console.log(`[provision-telnyx] created Call Control App ${dialerName} (${dialerId})`);
}
console.log(`[provision-telnyx] dialer webhook_event_url → ${EDGE_URL}/telnyx/status`);

// 3) Assign the number (must exist in the account first).
const numbers = await api("GET", `/phone_numbers?per_page=100`);
const numberRecord = (numbers.data ?? []).find(
  (n) => n.number === NUMBER || String(n.id) === NUMBER,
);
if (!numberRecord) {
  console.error(
    `[provision-telnyx] number ${NUMBER} not found in the account.\n` +
      `Order it first (Mission Control → Numbers → Search for Numbers),\n` +
      `then re-run this script.`,
  );
  process.exit(1);
}

await api("PATCH", `/phone_numbers/${numberRecord.id}`, {
  connection_id: appId,
});
console.log(`[provision-telnyx] assigned ${NUMBER} → TeXML app ${appId}`);

console.log(`\n[provision-telnyx] done. Call ${NUMBER} to talk to the dental receptionist.`);
console.log(`[provision-telnyx] set TELNYX_CONNECTION_ID=${dialerId} on the worker (outbound dials).`);
console.log("[provision-telnyx] reminder: set TELNYX_PUBLIC_KEY + TELNYX_STREAM_TOKEN");
console.log("[provision-telnyx] on the worker (secrets), or /telnyx/* refuses traffic.");
