# Plan: Deploy Firedash — Cloudflare-Native Architecture

## Context

Firedash is a Bun/TypeScript monorepo with three services: `incidentd` (Cloudflare Worker), `dashboard` (currently Vercel), and `status-page` (Next.js 16 on Vercel). The goal is to move everything to Cloudflare (Pages + Workers), simplify for single-tenant internal use, and replace HTTP-over-internet cross-service calls with Cloudflare-native bindings (service binding, Hyperdrive). This eliminates `DATABASE_URL`, `INCIDENTS_URL`, `WORKER_SIGNING_SECRET`, and all Stripe/Vercel-specific code.

---

## Recommended execution order

Do phases in this sequence to minimize risk:

1. **2c/2d first** — drop Stripe + Vercel SDK (dead code removal, no runtime impact)
2. **2a** — CLIENT_ID in auth (testable locally)
3. **2b** — Slack team_id lookup (requires care, see note below)
4. **3 + 4 together** — Cloudflare migration and HMAC removal (must deploy atomically)
5. **5** — Status-page to Cloudflare via OpenNext adapter
6. **6** — Secrets, DNS, external config

---

## Phase 1 — Infrastructure: PostgreSQL on AWS RDS

**Non-code work. All steps in the AWS Console unless noted.**

### Step 1 — Create a security group

Security groups control who can reach the RDS instance. Cloudflare Hyperdrive connects outbound from Cloudflare's IP ranges, so you need to allow those IPs on port 5432.

1. Go to **EC2 → Security Groups → Create security group**
2. Set:
   - **Name:** `firedash-rds`
   - **Description:** `Firedash RDS - Cloudflare Hyperdrive access`
   - **VPC:** select your default VPC
3. Under **Inbound rules**, add one rule per Cloudflare IPv4 range (type: `PostgreSQL`, port `5432`, source: each CIDR):
   ```
   173.245.48.0/20   103.21.244.0/22   103.22.200.0/22   103.31.4.0/22
   141.101.64.0/18   108.162.192.0/18  190.93.240.0/20   188.114.96.0/20
   197.234.240.0/22  198.41.128.0/17   162.158.0.0/15    104.16.0.0/13
   104.24.0.0/14     172.64.0.0/13     131.0.72.0/22
   ```
   > The current list is always at https://www.cloudflare.com/ips-v4/
4. Also add your own IP so you can run migrations locally:
   - Type: `PostgreSQL`, port `5432`, source: `My IP` (AWS fills this in automatically)
5. Click **Create security group** and note the security group ID.

### Step 2 — Create the RDS instance

1. Go to **RDS → Databases → Create database**
2. Choose:
   - **Creation method:** Standard create
   - **Engine:** PostgreSQL
   - **Engine version:** PostgreSQL 16 (latest minor, e.g. 16.x)
   - **Templates:** Free tier (or Production if you want Multi-AZ later)
3. Under **Settings**:
   - **DB instance identifier:** `firedash-prod`
   - **Master username:** `firedash`
   - **Master password:** generate a strong password and save it in a password manager — you will need it for every subsequent step
4. Under **Instance configuration:**
   - **DB instance class:** `db.t4g.micro` (sufficient for single-tenant internal use)
5. Under **Storage:**
   - **Storage type:** `gp3`
   - **Allocated storage:** `20 GiB`
   - **Storage autoscaling:** enabled, max `100 GiB`
6. Under **Connectivity:**
   - **VPC:** default VPC
   - **Public access:** **Yes** ← required for Cloudflare Hyperdrive to reach it
   - **VPC security group:** choose **Existing** → select `firedash-rds` (created in step 1)
   - **Availability zone:** no preference
7. Under **Additional configuration:**
   - **Initial database name:** `firedash`
   - **Automated backups:** enabled, retention `7 days`
   - **Deletion protection:** leave unchecked for now (enable after confirming everything works)
8. Click **Create database** — provisioning takes ~5 minutes. Wait for status to show **Available**.

### Step 3 — Get the connection string

1. Click the `firedash-prod` instance → **Connectivity & security** tab
2. Copy the **Endpoint** (looks like `firedash-prod.xxxxxxxxxxxx.eu-west-1.rds.amazonaws.com`) and **Port** (`5432`)
3. Build your connection string:
   ```
   postgresql://firedash:<password>@<endpoint>:5432/firedash
   ```
4. Test it from your local machine:
   ```bash
   psql "postgresql://firedash:<password>@<endpoint>:5432/firedash" -c "SELECT version();"
   ```

### Step 4 — Run migrations

From the `packages/db` directory in the repo:

```bash
cd /path/to/fire/packages/db
DATABASE_URL="postgresql://firedash:<password>@<endpoint>:5432/firedash" bunx drizzle-kit migrate
```

This applies all migration files from `packages/db/migrations/` in order. Confirm it exits with no errors.

### Step 5 — Insert the client row

```bash
psql "postgresql://firedash:<password>@<endpoint>:5432/firedash" <<'SQL'
INSERT INTO client (id, name, domains, default_user_role, auto_create_users_with_sso, is_startup_eligible)
VALUES (gen_random_uuid(), 'Firedash', '{}', 'VIEWER', true, false)
RETURNING id;
SQL
```

The returned UUID is your `CLIENT_ID`. **Save it** — it goes into every service's secrets in Phase 6.

### Step 6 — Create the Hyperdrive config in Cloudflare

Hyperdrive is the Cloudflare-side connection pooler. It needs to be configured once; the resulting ID is referenced in all three `wrangler.toml` files.

Check whether the existing Hyperdrive config (`985eb1686096409e90e6a42bb600a07e`) already points at the correct database, or create/update it now:

```bash
# If creating new (first time):
wrangler hyperdrive create firedash-prod \
  --connection-string "postgresql://firedash:<password>@<endpoint>:5432/firedash"

# If updating the existing config to point at the new RDS:
wrangler hyperdrive update 985eb1686096409e90e6a42bb600a07e \
  --connection-string "postgresql://firedash:<password>@<endpoint>:5432/firedash"
```

Note the Hyperdrive ID that comes back. If it differs from `985eb1686096409e90e6a42bb600a07e`, update the `id` field in all three `wrangler.toml` files (`services/incidentd/wrangler.jsonc`, and the new files for dashboard and status-page).

### Phase 1 checklist

- [ ] Security group `firedash-rds` created with Cloudflare IPs + your local IP on port 5432
- [ ] RDS instance `firedash-prod` status is **Available**
- [ ] Local `psql` connection works
- [ ] `drizzle-kit migrate` completes with no errors
- [ ] `client` row inserted, UUID saved as `CLIENT_ID`
- [ ] Hyperdrive config created/updated, ID confirmed in all `wrangler.toml` files

---

## Phase 2 — Single-tenant simplification

**Goal:** Replace dynamic multi-tenant lookups with a hardcoded `CLIENT_ID`. Does not remove multi-tenancy code — just bypasses it at three origin points.

### 2a. Dashboard auth — email-domain lookup

**File:** `services/dashboard/src/lib/auth/auth.ts` — lines 154–170

Replace the email-domain DB query and error with a direct env-var lookup:

```ts
// Before (lines 160–164)
const [foundClient] = await db
    .select()
    .from(client)
    .where(arrayContains(client.domains, [domain]))
    .limit(1);
if (!foundClient) throw new APIError("UNPROCESSABLE_ENTITY", { ... });

// After
const foundClient = { id: process.env.CLIENT_ID! };
```

The code from line 172 onwards (user count, role assignment) continues unchanged — it still uses `foundClient.id`.

Note: the personal-domain blocklist check (lines 154–158) can be removed since we control who logs in — or kept for safety. **Recommendation: keep it** to avoid accidental signups.

### 2b. incidentd Slack integration — team_id lookup

**File:** `services/incidentd/src/adapters/slack/receiver/utils.ts` — `getSlackIntegration()`, lines 702–827

`getSlackIntegration` is ~125 lines and handles Enterprise Grid (`enterpriseId`, `isEnterpriseInstall`), entry point loading, and service loading — all keyed off the `clientId` returned by the DB lookup. **Only replace the DB query portion**, not the rest of the function.

Find the raw SQL `EXISTS` subquery that resolves `teamId → clientId` (around line 712) and replace only that lookup:

```ts
// Before: raw SQL EXISTS subquery matching teamId/enterpriseId → client row
// db.query.client.findFirst({ where: EXISTS(integration WHERE teamId = ...) })

// After: bypass the client lookup entirely
const clientId = c.env.CLIENT_ID;
```

The function signature and all downstream logic (fetching integrations, entry points, services for that `clientId`) stays unchanged.

### 2c. Drop Stripe billing

- Remove any imports/usage of `STRIPE_*` env vars throughout `services/dashboard/`
- Remove the `client_billing` table references (do not drop the DB table — just stop using it in code)
- Remove the `/api/billing/webhook` route file
- Remove the `stripe` server SDK from `services/dashboard/package.json` (confirmed present as `stripe ^18.x`; there is no `@stripe/stripe-js` client SDK — only the server package needs removing)

### 2d. Drop Vercel domain management

- Remove any code using `VERCEL_TOKEN` or `VERCEL_STATUS_PROJECT_ID` (these were for per-customer custom domains)
- Remove `@vercel/sdk` from `services/dashboard/package.json`

**Verification:** Run `bun typecheck` in `services/dashboard/`. Log in with a Google account — should be assigned `CLIENT_ID` automatically without domain matching.

---

## Phase 3 — Dashboard: migrate to Cloudflare Pages

### 3a. Nitro preset swap

**File:** `services/dashboard/vite.config.ts` — lines 29–36

```ts
// Before
nitro({ preset: "vercel", vercel: { functions: { runtime: "bun1.x" } } })

// After
nitro({ preset: "cloudflare_pages" })
```

### 3b. Create wrangler.toml for dashboard

**New file:** `services/dashboard/wrangler.toml`

```toml
name = "dashboard"
compatibility_date = "2025-12-19"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = ".output/public"

[[services]]
binding = "INCIDENTD"
service = "incidentd"

[[hyperdrive]]
binding = "DB"
id = "985eb1686096409e90e6a42bb600a07e"

[[r2_buckets]]
binding = "IMAGES"
bucket_name = "fire-images"
```

The Hyperdrive ID `985eb1686096409e90e6a42bb600a07e` already exists (used by incidentd). Multiple Workers sharing the same Hyperdrive config is supported and intentional — they share the connection pool limit, which is fine for single-tenant use.

### 3c. Replace `@vercel/functions` in db.ts

**File:** `services/dashboard/src/lib/db.ts`

```ts
// Before
import { attachDatabasePool } from "@vercel/functions";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, ... });
attachDatabasePool(pool);

// After — Hyperdrive provides connectionString via binding
import type { Env } from "../env";  // or wherever Env is typed
export function createDb(env: Env) {
  const pool = new Pool({ connectionString: env.DB.connectionString, ... });
  return drizzle({ schema, relations, client: pool });
}
```

Remove `max: 1` — Hyperdrive manages connection pooling automatically. Also remove `allowExitOnIdle: true` — irrelevant on Cloudflare Workers.

Note: if the dashboard uses a module-level singleton `db`, it will need to become a per-request factory, passed via context (standard Cloudflare Workers pattern).

### 3d. Replace `signedFetch` with service binding

**File:** `services/dashboard/src/lib/utils/server.ts`

Remove `createAuthHeaders`, `signedFetch` (lines 24–53) and `WORKER_SIGNING_SECRET` usage. Add:

```ts
export async function incidentdFetch(
  env: Env,
  path: string,
  authContext: { clientId: string; userId: string },
  init?: RequestInit
): Promise<Response> {
  return env.INCIDENTD.fetch(
    new Request("https://incidentd" + path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        "X-Client-Id": authContext.clientId,
        "X-User-Id": authContext.userId,
      },
    })
  );
}
```

**Update all call sites** — verify exact counts before starting:
```bash
grep -n "signedFetch" services/dashboard/src/lib/incidents/incidents.ts services/dashboard/src/lib/incident-affections/incident-affections.ts
```

- `services/dashboard/src/lib/incidents/incidents.ts` — **8 call sites** (list, getById, assignee, severity, status, message, start, + 1 more): replace `signedFetch(INCIDENTS_URL + path, ...)` with `incidentdFetch(env, path, ...)`
- `services/dashboard/src/lib/incident-affections/incident-affections.ts` — **5 call sites**: same swap

Remove `INCIDENTS_URL` env var references from both files.

### 3e. Replace `@vercel/blob` with R2

**Before starting**, create the R2 bucket in Cloudflare (it must exist before deploy):
```bash
wrangler r2 bucket create fire-images
```

Then find all `@vercel/blob` usages:
```bash
grep -r "@vercel/blob\|from \"@vercel/blob\"" services/dashboard/src/
```

Replace each `put()`/`del()`/`head()` call with the R2 binding equivalent (`env.IMAGES.put()`, etc.). The `wrangler.toml` R2 binding is already included in step 3b.

### 3f. Replace `waitUntil` from `@vercel/functions`

First confirm whether any `waitUntil` usage exists:
```bash
grep -r "waitUntil" services/dashboard/src/
```

If found, replace with `ctx.waitUntil()` where `ctx` is the Cloudflare execution context (available in Nitro's Cloudflare adapter via `useNitroApp().localFetch` event context or passed explicitly). If nothing is found, skip this step.

**Verification:** `wrangler pages dev` locally → confirm sign-in, incident list loads, incident creation routes to incidentd.

---

## Phase 4 — incidentd: remove HMAC, accept plain headers

This phase is **coupled with Phase 3** — both must be deployed together, as the service binding removes HMAC from the transport.

**File:** `services/incidentd/src/adapters/dashboard/receiver/middleware.ts`

Replace `verifyDashboardRequestMiddleware` (entire file, ~72 lines):

```ts
// After — service binding authenticates at network level; just extract headers
export async function verifyDashboardRequestMiddleware(c: Context<AuthContext>, next: Next) {
  const clientId = c.req.header("X-Client-Id");
  const userId = c.req.header("X-User-Id");

  if (!clientId || !userId) {
    return c.json({ error: "Unauthorized: Missing auth headers" }, 401);
  }

  c.set("auth", { clientId, userId });
  await next();
}
```

Remove `verifyHmacSignature` helper and `WORKER_SIGNING_SECRET` from the `incidentd` Env type.

**Note on the self-referencing service binding:** The existing `wrangler.jsonc` has a `services` binding pointing at itself (`incidentd → incidentd`). This is intentional — it is used for Durable Object RPC between workflow steps, a standard Workers pattern. Do not remove it.

**Verification:** Deploy both together. Send a test request from dashboard → incidentd, confirm 200 without HMAC headers.

---

## Phase 5 — Status-page: deploy to Cloudflare via OpenNext adapter

The status-page runs Next.js 16 with `"use cache"` + `cacheLife()` and 12 pure server route handlers returning raw HTML. Rather than rewriting to a different framework, use `@opennextjs/cloudflare` — the official Cloudflare adapter for Next.js — which deploys Next.js apps to Cloudflare Pages with no framework change required.

### 5a. Install OpenNext adapter

**File:** `services/status-page/package.json`

Add to `devDependencies`:
```json
{
  "@opennextjs/cloudflare": "^1.x"
}
```

No changes to `next`, `react`, or `react-dom`.

### 5b. Create open-next.config.ts

**New file:** `services/status-page/open-next.config.ts`

```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
```

### 5c. Create wrangler.toml for status-page

**New file:** `services/status-page/wrangler.toml`

```toml
name = "status-page"
compatibility_date = "2025-12-19"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = ".open-next/assets"

[[hyperdrive]]
binding = "DB"
id = "985eb1686096409e90e6a42bb600a07e"
```

### 5d. Migrate db.ts

**File:** `services/status-page/src/lib/db.ts`

The status-page currently uses a plain `pg.Pool` without `@vercel/functions`. Swap `process.env.DATABASE_URL` for `env.DB.connectionString` and remove `max: 1`:

```ts
// Before
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, ... });

// After — env comes from Cloudflare bindings via OpenNext
export function createDb(env: CloudflareEnv) {
  const pool = new Pool({ connectionString: env.DB.connectionString, ... });
  return drizzle({ schema, relations, client: pool });
}
```

Define `CloudflareEnv` to include the `DB: Hyperdrive` binding. OpenNext exposes Cloudflare bindings via `getRequestContext().env` in Next.js route handlers.

### 5e. Update build script

**File:** `services/status-page/package.json`

Update the build script to use OpenNext:
```json
{
  "scripts": {
    "build": "opennextjs-cloudflare build",
    "preview": "opennextjs-cloudflare preview"
  }
}
```

### 5f. Handle `"use cache"` + `cacheLife()` compatibility

Next.js 16's `"use cache"` + `cacheLife()` works with OpenNext's Cloudflare adapter. No changes needed to `services/status-page/src/lib/status-pages.server.ts` or the intercom route — the existing caching directives are preserved as-is. Verify the adapter version supports Next.js 16's cache API before deploying.

**Verification:** `opennextjs-cloudflare preview` locally → hit `/` for a status page by domain, `/[slug]` for slug-based, `/[slug]/feed.rss` for RSS. Confirm cached responses.

---

## Phase 6 — Deploy and configure

### Pre-deploy checklist

- [ ] R2 bucket created: `wrangler r2 bucket create fire-images`
- [ ] Hyperdrive config `985eb1686096409e90e6a42bb600a07e` confirmed accessible by dashboard and status-page workers
- [ ] All secrets set (see below)

### Deploy order

1. `cd services/incidentd && wrangler deploy` (Phase 4 changes)
2. Dashboard: `cd services/dashboard && bun run build && wrangler pages deploy .output/public --project-name dashboard`
3. Status-page: `cd services/status-page && bun run build && wrangler pages deploy .open-next/assets --project-name status-page`

### Cloudflare secrets to set (via `wrangler secret put` or dashboard)

**incidentd:**
```
SLACK_SIGNING_SECRET, OPENAI_API_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, CLIENT_ID
```

**dashboard (Pages):**
```
BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, CLIENT_ID, VITE_APP_URL
```

**status-page (Pages):**
```
VITE_APP_URL, VITE_STATUS_PAGE_DOMAIN, INTERCOM_CLIENT_SECRET, CLIENT_ID
```

### External configuration

- **Slack app:** Update Event Subscriptions URL and Slash Command URLs to point to the new incidentd Worker URL.
- **Google OAuth:** Add `https://app.firedash.ai/api/auth/callback/google` to authorized redirect URIs.
- **Slack OAuth:** Update redirect URI to `https://app.firedash.ai/api/auth/callback/slack`.
- **DNS:** Point `app.firedash.ai` → Cloudflare Pages (dashboard), status page domain → status-page Pages project.

---

## Files to change (summary)

| File | Change |
|---|---|
| `services/dashboard/src/lib/auth/auth.ts` | Replace email-domain DB lookup with `process.env.CLIENT_ID` |
| `services/dashboard/src/lib/utils/server.ts` | Remove `createAuthHeaders`/`signedFetch`; add `incidentdFetch` via service binding |
| `services/dashboard/src/lib/db.ts` | Swap `DATABASE_URL` → `env.DB.connectionString`; remove `@vercel/functions`; remove `max: 1` and `allowExitOnIdle` |
| `services/dashboard/src/lib/incidents/incidents.ts` | Replace `signedFetch(INCIDENTS_URL+path)` → `incidentdFetch(env, path)` (8 call sites) |
| `services/dashboard/src/lib/incident-affections/incident-affections.ts` | Same swap (5 call sites) |
| `services/dashboard/vite.config.ts` | Swap preset `"vercel"` → `"cloudflare_pages"` |
| `services/dashboard/wrangler.toml` | **New file** — service binding + Hyperdrive + R2 |
| `services/dashboard/package.json` | Remove `@vercel/blob`, `@vercel/functions`, `@vercel/sdk`, `stripe` |
| `services/incidentd/src/adapters/dashboard/receiver/middleware.ts` | Replace HMAC verify with plain header extraction |
| `services/incidentd/src/adapters/slack/receiver/utils.ts` | Replace client DB lookup (query only) with `env.CLIENT_ID`; leave rest of function unchanged |
| `services/status-page/package.json` | Add `@opennextjs/cloudflare`; update build script |
| `services/status-page/open-next.config.ts` | **New file** — OpenNext Cloudflare config |
| `services/status-page/wrangler.toml` | **New file** — Hyperdrive binding |
| `services/status-page/src/lib/db.ts` | Swap `DATABASE_URL` → `env.DB.connectionString`; remove `max: 1` |

Files that do **not** need to change (vs. original plan):
- `services/status-page/src/lib/status-pages.server.ts` — `"use cache"` + `cacheLife()` works with OpenNext
- `services/status-page/src/app/**/route.ts` (12 files) — no rewrite needed
- `services/status-page/next.config.ts` — keep as-is

---

## Coupling note

**Phase 3 (dashboard) and Phase 4 (incidentd HMAC removal) must be deployed atomically.** Deploy incidentd first (it accepts both old HMAC headers and new plain headers if you do a brief transition period), then deploy dashboard. Alternatively, deploy both in the same deploy window.

---

## Verification end-to-end

1. Open dashboard → sign in via Google → should auto-assign CLIENT_ID (no domain matching)
2. Dashboard loads incident list → incidentd responds via service binding (no INCIDENTS_URL)
3. Create an incident → Slack notification fires → incidentd identifies client via CLIENT_ID
4. Status page renders at configured domain → Hyperdrive connection pools to RDS
5. RSS feed at `/[slug]/feed.rss` returns valid XML
