// Local dev stub — overwritten at deploy time by the console worker.
//
// AUTH_MODE (optional) forces the auth strategy and overrides inference:
//   "disabled"    → localhost/LAN dev (no login; synthetic local user)
//   "standalone"  → self-hosted: the brain issues its own JWTs and the UI
//                   shows a real Login page (no agentdeploy.io dependency).
//                   Pair with MARKETPLACE_URL "none"/"self"/"" and a reachable
//                   BRAIN_URL (the brain's /auth/* endpoints).
//   "marketplace" → agentdeploy.io hosted flows (subdomain cookie / custom
//                   domain token exchange).
// When omitted the UI infers: localhost → "disabled"; MARKETPLACE_URL
// empty/"none"/"self" → "standalone"; otherwise → "marketplace".
//
// Whitelabeling (all optional) — rebrand the console without a rebuild:
//   BRAND_NAME    → console name in the sidebar, login page and tab title
//                   (default "Calla"). Also settable via VITE_BRAND_NAME.
//   BRAND_TAGLINE → line under the brand name (default "HITL Orchestration").
//                   Also settable via VITE_BRAND_TAGLINE.
//   BRAND_ACCENT  → hex color ("#0f766e") overriding the --primary accent at
//                   boot; invalid values are ignored. Also VITE_BRAND_ACCENT.
//
// Per-deployment modules (optional) — BUILD-TIME fallback only:
//   ENABLED_MODULES → array (or comma string) of module ids, e.g.
//                   ["fleet","inbox","conversations","reports","setup",
//                    "agents","voice","booking","skills"] for the dental
//                   preset. Empty/absent = all modules enabled. The brain's
//                   /config/modules row (Setup → Modules) wins when reachable.
window.__CALLA_CONFIG__ = {
  MARKETPLACE_URL: "https://agentdeploy.io",
  DEPLOYMENT_API_URL: "",
  BRAIN_URL: "/brain",
  // AUTH_MODE: "standalone",
  // BRAND_NAME: "Acme Solar",
  // BRAND_TAGLINE: "Retrofit Sales Console",
  // BRAND_ACCENT: "#0f766e",
};
