# Secret & API-Key Audit — Customer Key Exposure Risk

**Date:** 2026-10-22
**Trigger:** Railway.com customer environment-variable compromise; assessment of how this platform could be breached in a similar way and how attackers could steal customer keys.
**Scope:** `deployment-service` (control plane) + `packages/*` (SDKs, CLI, edge UI, runtime).

---

## Headline

The platform's "encryption at rest" is keyed by a plaintext environment variable, and
every other control-plane secret is a plaintext env var too. A Railway-style
env-variable compromise is exactly the one threat the current design does **not**
protect against — it hands the attacker the keys to decrypt or re-fetch every
customer secret.

---

## What an env-variable breach actually yields (the direct answer)

With a Railway-style env dump, an attacker obtains, in priority order:

1. **`INTERNAL_SERVICE_TOKEN`** → call
   `GET /internal/deployments/:id/secrets/revealed?includeValues=true` for any
   deployment id and receive **plaintext customer secrets**. One request, no
   per-tenant token. (`deployment-service/src/routes/internal.ts:2569`, gated only
   by `middleware/internal-auth.ts`.)
2. **`SECRETS_ENCRYPTION_KEY`** → the master KEK that unwraps every deployment DEK.
   The wrapped DEK is stored *inline in the same DB row as the ciphertext*, so
   KEK + Directus dump = full decryption of anything ever stored encrypted.
   (`lib/secrets/envelope.ts` `getKEK()` + `encrypt()`.)
3. **`AD_BROKER_TOKEN`** (per machine, injected into the customer VM's env at deploy —
   `services/flyio-deployments.ts:270/372`) → call the publicly reachable
   `GET /v1/broker/secrets` and receive that deployment's plaintext secrets. Tokens
   are nominally 15-minute TTL but renewable without a ceiling, so effectively
   long-lived while the machine runs.
4. **The platform's own upstream keys** — `LLM_PROVIDER_SECRET_KEY`,
   `LLM_TOKEN_API_KEY_SECRET`, `CLOUDFLARE_API_TOKEN`, `EDGE_CF_API_TOKEN`,
   `STRIPE_SECRET_KEY`, `R2_SECRET_ACCESS_KEY`, `FLY_API_TOKEN`,
   `DIRECTUS_*_TOKEN`, `REDIS_URL` (`env.ts`). The attacker does not need customer
   keys — they get the keys that power all customer inference, with higher privilege.

---

## Findings by severity

### Critical

- **C1 — Master KEK lives in a plaintext env var.**
  The envelope-encryption scheme ("per-deployment DEK wrapped by a KEK") is
  decorative against an env breach: `SECRETS_ENCRYPTION_KEY` is a 64-hex env
  string and the wrapped DEK travels with the ciphertext. The `kek: "kms"`
  migration path is a comment, never implemented.
  *Files:* `deployment-service/src/lib/secrets/envelope.ts`,
  `deployment-service/src/env.ts:52-56`.

- **C2 — Plaintext secret-dump endpoint behind a shared env token.**
  `/internal/deployments/:id/secrets/revealed?includeValues=true` returns
  `{key, value}` in the clear; its only auth is
  `X-Internal-Token` == `INTERNAL_SERVICE_TOKEN` (an env var), and the `userId`
  ownership check is just a query parameter.
  *Files:* `routes/internal.ts:2569`, `middleware/internal-auth.ts`.

### High

- **H1 — Broker token is a long-lived plaintext secret on the machine env, and its
  endpoint is public.** `/v1/broker/secrets` is registered before the `/v1/*`
  API-key gateway (`index.ts:98`), protected only by the broker token.
  `renewBrokerToken()` extends TTL on every call with no lifetime cap. Env breach →
  read every machine's `AD_BROKER_TOKEN` → drain plaintext secrets.

- **H2 — The secret pipeline is internally inconsistent (half-migrated).**
  `deployment-deks.ts` `getEncryptedDEK()` now always returns `null` ("phantom
  column"), so `storeEncryptedSecret()` always fails (`secrets-envelope.ts:50`).
  Consequence: the Directus envelope store is **not being written** while the
  broker/revealed endpoints **read from it** (empty/stale), and the *real* values
  live in Cloudflare Workers secret bindings. Core-deployment secret writes via
  `storeEncryptedSecret` as the primary bind (`services/secrets.ts:270`) are broken.
  During a breach you cannot reliably say where a given key lives.

- **H3 — Platform upstream keys are plaintext env vars** (see point 4 above). The
  `LLM_CREDENTIAL_POOL` exists but its credentials still come from env/config, not
  a KMS.

### Medium

- **M1 — Customer API keys: unsalted HMAC-SHA256 with a single env
  `API_KEY_SECRET`.** Good that they are hashed (not plaintext), but the HMAC key is
  another env secret — an env breach lets an attacker forge/verify/offline-crack
  keys, and rotating `API_KEY_SECRET` invalidates every key. The 14-char
  `key_prefix` is stored in cleartext (`lib/api-keys.ts`).

- **M2 — Logger redaction is partial.** pino redacts
  `authorization/token/apiKey/secret/password` but not
  `secretValue`/`secret_value`/`plaintext`/`value`/`key` (`logger.ts:15-28`).

- **M3 — One shared internal secret, no least-privilege.** All `/internal/*` routes
  share one `INTERNAL_SERVICE_TOKEN` with no per-route or per-tenant scoping; the
  origin allowlist defaults to `http://localhost:2000`.

### Positive controls worth keeping

- Gateway/CLI API keys are HMAC-hashed at rest, not plaintext (`api-keys.ts`).
- Broker tokens are HMAC-hashed before hitting Redis (raw token not persisted).
- Timing-safe comparison used for internal token and API-key match.
- Runtime keeps secrets memory-only (`core-sdk/secrets.ts`); dashboard/CLI list
  endpoints return only key names + `configured` flags, never values.

---

## Recommended remediation, in order

1. Add a pre-commit + CI secret scanner (`gitleaks`/`trufflehog`) so a stray key can
   never reach git — cheap insurance, independent of the fixes below.
2. **Move the KEK out of env** into a KMS / external secrets manager (AWS KMS, GCP
   Secret Manager, Vault, or Doppler). The `kek: "kms"` hook already exists in
   `envelope.ts` — implement it.
3. **Remove or harden** `GET /internal/deployments/:id/secrets/revealed?includeValues=true`.
   If it must exist, gate it behind a dedicated, short-lived, audited,
   per-operation credential — not the shared `INTERNAL_SERVICE_TOKEN` — and
   rate-limit + alert on it.
4. **Fix the broken pipeline (H2).** Pick one model and ship it: either
   *Cloudflare-only zero-knowledge* (delete the Directus envelope + broker reads) or
   *working envelope + KMS* (persist the DEK properly). Do not leave a half-migrated
   state.
5. **Cap broker-token lifetime** (single-use bootstrap, non-renewable, or a max
   lifetime) and stop treating `AD_BROKER_TOKEN` as a long-lived machine secret;
   consider minting at boot via the deploy engine rather than persisting in env.
6. **Move platform upstream LLM/provider keys into the credential pool backed by a
   secrets manager**, not `env.ts`.
7. **Tighten pino redaction** (`secretValue`, `secret_value`, `plaintext`, `value`,
   `key`) and scope `/internal/*` origins/tokens per service.

---

## Scope caveats

Reviewed `deployment-service` (control plane) and `packages/*` (SDKs/CLI/UI). Not
deep-inspected: the `agent-deploy` marketplace service (Better Auth
`/api/edge/session`, `/api/edge/authorize`), the `credential-pool` storage backend,
the Cloudflare Workers secret-binding internals, or the live Directus schema. H2's
"envelope store empty vs. contains legacy rows" needs a quick live check, and the
marketplace auth surface warrants a follow-up pass.
