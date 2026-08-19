# Authentication Architecture

## Overview

The Edge Console integrates with the **AgentDeploy Marketplace** (agentdeploy.io)
identity system, which uses **Better Auth** for authentication. When a buyer
purchases agent templates on the marketplace, they receive a hosted Edge Console
instance at either a subdomain or a custom domain, depending on their tier.

There are **three auth paths**, automatically selected based on where the
console is deployed:

| Path | Deployment | Auth Mechanism | Domain Example |
|------|-----------|----------------|----------------|
| 1 | AgentDeploy Subdomain | Better Auth session cookie (cross-subdomain) | `{handle}.agentdeploy.io` |
| 2 | Custom Domain | Edge JWT via token exchange | `agents.acme.com` |
| 3 | Local Dev | Auth disabled (synthetic user) | `localhost` |

## Hosting Tiers

The auth path is determined by the buyer's subscription tier:

| Tier | Price | Domain Type | Agent Limit | Token Allowance |
|------|-------|-------------|-------------|-----------------|
| Sandbox | Free | `*.edge.agentdeploy.io` | 1 | 10K |
| Starter | $19/mo | `*.agentdeploy.io` | 4 | 100K |
| Pro | $49/mo | Custom or subdomain | 12 | 500K |
| Business | $199/mo | Custom or subdomain | 35 | 2M |

Custom domains are a **Pro/Business** feature only. Sandbox and Starter tiers
get auto-generated subdomains under `agentdeploy.io`.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Marketplace (agentdeploy.io)                                │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Better Auth                                         │    │
│  │  • OAuth: Google, GitHub, Discord, LinkedIn          │    │
│  │  • Email/password + email verification               │    │
│  │  • Session cookie: better-auth.session_token         │    │
│  │  • Cross-subdomain cookies: .agentdeploy.io          │    │
│  └───────────────────────┬─────────────────────────────┘    │
│                          │                                   │
│  ┌───────────────────────▼─────────────────────────────┐    │
│  │  API Endpoints                                       │    │
│  │  • GET  /api/edge/session  → validate + return user  │    │
│  │  • GET  /api/edge/authorize → token exchange (JWT)   │    │
│  │  • POST /api/edge/logout   → clear session           │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                           │
            ┌──────────────┴──────────────┐
            │                             │
            ▼                             ▼
┌───────────────────────┐   ┌───────────────────────────────┐
│  Subdomain Console     │   │  Custom Domain Console         │
│  {handle}.agentdeploy.io│   │  agents.acme.com               │
│                        │   │                                 │
│  Session cookie sent   │   │  Path 2: Token Exchange         │
│  automatically         │   │  1. Redirect to authorize       │
│  (same parent domain)  │   │  2. Marketplace validates sess  │
│                        │   │  3. Issues edge JWT (5 min TTL) │
│  Path 1: Session       │   │  4. Redirect back ?edge_token=  │
│  • verifySession()     │   │  5. Store in localStorage        │
│  • credentials:include │   │  6. Use as Bearer token          │
└───────────────────────┘   └───────────────────────────────┘
```

## Path 1: Subdomain Auth (Sandbox/Starter/Pro/Business)

When the Edge Console runs on `*.agentdeploy.io`, the Better Auth session
cookie (`better-auth.session_token`) carries over automatically because
Better Auth is configured with **cross-subdomain cookies** scoped to
`.agentdeploy.io`.

**Client-side flow:**
1. User visits `{handle}.agentdeploy.io`
2. `useAuth` hook calls `GET https://agentdeploy.io/api/edge/session` with
   `credentials: "include"`
3. The session cookie is sent automatically (same parent domain)
4. The marketplace validates the Better Auth session server-side
5. Returns `{ authenticated: true, user: {...} }` or 401

**API calls:**
All HTTP requests use `credentials: "include"` (via `authFetch()`), which
sends the session cookie automatically. No Bearer token needed.

**WebSocket auth:**
The session cookie is sent with the WebSocket upgrade request (same-origin).
No query param or header needed.

## Path 2: Custom Domain Auth (Pro/Business only)

When the Edge Console runs on a custom domain (e.g., `agents.acme.com`),
Better Auth cookies **don't carry over** (different domain). We use a
**token exchange** pattern:

**Flow:**
1. User visits `agents.acme.com`
2. `useAuth` hook checks localStorage for `edge_console_jwt`
3. If missing or expired → redirect to:
   ```
   https://agentdeploy.io/api/edge/authorize?return_url=https://agents.acme.com
   ```
4. Marketplace validates the Better Auth session (user must be logged in)
5. Marketplace issues a short-lived **edge JWT** (5 minutes)
6. Redirects back to: `agents.acme.com/?edge_token=xxx`
7. Console stores the JWT in localStorage + cleans the URL
8. All subsequent API calls use `Authorization: Bearer <jwt>`

**Edge JWT payload:**
```json
{
  "sub": "user-uuid",
  "email": "buyer@example.com",
  "name": "Jane Buyer",
  "role": "buyer",
  "iss": "https://agentdeploy.io",
  "aud": "agents.acme.com",
  "exp": 1735689600,
  "iat": 1735689300,
  "tier": "pro",
  "dep": ["deployment-1", "deployment-2"]
}
```

**Refresh:**
The edge JWT has a 5-minute TTL. The `useAuth` hook re-checks every 5
minutes and on window focus. If expired, the hook redirects back through
the token exchange flow (silent if the Better Auth session is still valid).

**WebSocket auth:**
Browsers can't set custom headers on WebSocket connections. For custom
domains, the edge JWT is appended as a query parameter:
```
wss://agents.acme.com/agents/support/default?token=<jwt>
```

## Path 3: Local Development (Auth Disabled)

On localhost, auth is completely disabled. The `AUTH_DISABLED` constant
in `src/constants/auth.ts` returns `true` when:
- `hostname` is `localhost`, `127.0.0.1`, `0.0.0.0`, `192.168.*`, or `10.*`
- `VITE_AUTH_DISABLED=true` env var is set

A synthetic `Local Developer` user is used, and the hardcoded `AGENTS`
array from `constants/agents.ts` provides agent definitions.

## Multi-Template Support

A buyer may purchase **multiple agent templates** from different sellers.
The console dynamically loads their purchased templates from the
deployment-service API, rather than using a hardcoded agent list.

The `PurchasedTemplate` type (in `src/types/auth.ts`) represents a single
purchased agent deployment:
```typescript
interface PurchasedTemplate {
  id: string;              // deployment ID
  name: string;            // template name from marketplace
  description: string;
  icon: string;
  kind: "chat" | "cron" | "api" | "worker";
  wsPath: string;          // WebSocket path
  supportsChat: boolean;
  hasCron: boolean;
  capabilities: string[];
  sellerName?: string;
  templateId?: string;
  deploymentStatus?: "active" | "suspended" | "pending" | "failed";
  customDomain?: string | null;
}
```

In production, the console will fetch these from:
```
GET {DEPLOYMENT_API_URL}/v1/deployments
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_AUTH_DISABLED` | auto | Override auth check (`true`/`false`) |
| `VITE_MARKETPLACE_URL` | `https://agentdeploy.io` | Marketplace base URL |
| `VITE_DEPLOYMENT_API_URL` | _(empty in dev)_ | Deployment-service API URL |

## API Endpoints (Marketplace Side)

These endpoints must be implemented on the marketplace
(`agentdeploy.io`):

### `GET /api/edge/session`
Validates the Better Auth session cookie and returns user info.

**Request:** Cookie `better-auth.session_token` (sent automatically)
**Response (200):**
```json
{
  "authenticated": true,
  "user": {
    "id": "uuid",
    "email": "buyer@example.com",
    "name": "Jane Buyer",
    "emailVerified": true,
    "role": "buyer",
    "status": "active"
  }
}
```
**Response (401):** `{ "authenticated": false }`

### `GET /api/edge/authorize`
Token exchange for custom-domain auth bridging.

**Query params:** `return_url` — the full URL to redirect back to
**Requires:** Valid Better Auth session cookie
**Response:** 302 redirect to `{return_url}?edge_token={jwt}`

The edge JWT:
- Signed with the marketplace's JWT secret
- TTL: 5 minutes
- Contains: sub, email, name, role, iss, aud, exp, iat, tier, dep[]

### `POST /api/edge/logout`
Clears the Better Auth session and redirects to login.

## Client-Side Files

| File | Purpose |
|------|---------|
| `src/constants/auth.ts` | Auth config, tier definitions, domain helpers |
| `src/types/auth.ts` | AuthUser, AuthState, HostingSubscription, EdgeJwtPayload |
| `src/hooks/useAuth.tsx` | AuthProvider + useAuth hook (session/JWT logic) |
| `src/hooks/useAuthFetch.ts` | authFetch() + buildAuthedWsUrl() helpers |
| `src/components/shared/AuthGuard.tsx` | Route gate (login screen) |
| `src/components/layout/TopBar.tsx` | UserMenu (avatar, name, logout) |

## Security Notes

- Better Auth session cookies are `HttpOnly` — not readable by JavaScript
- The client-side JWT decode is **non-cryptographic** — it only reads
  the payload for display. All actual authorization happens server-side.
- Edge JWTs are short-lived (5 min) and scoped to a specific audience
  (the custom domain). Even if stolen, they expire quickly.
- LLM API keys (Chutes AI, OpenAI, etc.) are stored as Worker secrets —
  never exposed to the client.
- The token exchange endpoint requires a valid Better Auth session, so
  only authenticated marketplace users can get edge JWTs.

## Worker Middleware (Server-Side)

Agent Workers should validate auth on all requests. For subdomain
deployments, the Worker validates the Better Auth session cookie. For
custom domains, the Worker validates the edge JWT from the `Authorization`
header or `?token=` query param.

Example middleware pattern:
```typescript
// _middleware.ts
export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);

  // Skip auth for health checks in dev
  if (url.pathname === "/health" && context.env.AUTH_DISABLED) {
    return context.next();
  }

  // Check for edge JWT (custom domain)
  const authHeader = context.request.headers.get("Authorization");
  const queryToken = url.searchParams.get("token");
  const token = authHeader?.replace("Bearer ", "") ?? queryToken;

  if (token && token !== "session") {
    // Validate edge JWT signature + expiry
    const payload = await verifyJwt(token, context.env.JWT_SECRET);
    if (!payload || payload.exp < Date.now() / 1000) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // For subdomain auth, the session cookie is validated server-side
  // via the marketplace API or a shared session store.

  return context.next();
};
```
