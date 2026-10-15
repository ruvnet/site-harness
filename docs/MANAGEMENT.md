# Hosted management console

The console is a responsive Cloudflare Worker application with D1 persistence.
The branded `/signup` and `/signin` pages accept a workspace access code. The
code is provisioned privately and must never be committed or documented. The
Worker checks its SHA-256 hash from the `CONSOLE_CODE_HASH` binding and issues an
eight-hour `__Host-site_harness` cookie
with Secure, HttpOnly and SameSite=Strict. D1 stores only session hashes; logout
revokes them, and changing the code hash invalidates existing sessions. Login is
limited to eight attempts per address per fifteen-minute window. Same-origin
checks protect sign-in, sign-out and management mutations. Public assets contain
no workspace data. Signed Cloudflare Access JWTs are also verified when supplied
by an optional gateway; the hosted console uses its own code sign-in. A paired Node desktop agent polls `/agent/*` with its own revocable token.
Website cookies, environment tokens and raw captures remain on that desktop.
Only redacted results, schemas and metadata are synchronized.

The interface provides Projects, Sources, Inspector, Capabilities, Compose,
Preview, Deploy and Settings views. Remix projects persist source bindings,
capability mappings and visual composition metadata in D1. Credentials, raw
captures and private response bodies remain outside project definitions.
Desktop uses a sidebar; mobile uses compact navigation and stacked controls.
Animated SVGs use actual inventory and job data, support reduced motion, and
remain readable when animation is paused. No demo statistics are presented as
live data.

## Shared interface contract

All JSON endpoints use `{ok:true,...}` or `{ok:false,error:string}`. Times are
ISO UTC strings. IDs are UUIDs, except target/operation names and capture IDs.

- `GET /api/state?agentId=<UUID>`: `{ok,user:{email},settings,agents,snapshot,jobs,remixes}`.
  An optional agent selects its snapshot and jobs; without it the freshest
  enabled snapshot is returned. Settings:
  `{captureTimeoutMs:30000,refreshIntervalMs:4000,includeStatic:false,reducedMotion:false}`.
  Agents: `{id,name,version,lastSeenAt,status:'online'|'offline',enabled}`.
  Snapshot: `{sites,captures,doctor,at}` or `null`; sites contain the Target fields
  plus `site`, `access`, `credentialConfigured`, and `operations:Operation[]`.
  Captures: `{id,site,url,at,requestCount}`. No raw capture contents.
  Job: `{id,agentId,action,args,status:'queued'|'running'|'succeeded'|'failed'|'cancelled',createdAt,startedAt,finishedAt,result,error}`.
- `POST /api/jobs`: `{agentId,action,args}` -> `{ok,job}`. Core action names match
  the fourteen published MCP tools. Also `target.save`, `target.remove`,
  `operation.remove`, and `sync`. Only known actions are accepted. Job args are
  limited to 64 KiB. Mutations require a same-origin `Origin` header.
- `POST /api/jobs/:id/cancel`: cancels a queued job only; running jobs cannot be
  assumed cancellable or retried.
- `PUT /api/settings`: strict settings above -> `{ok,settings}`.
- `GET /api/remixes`: lists up to 100 persisted remix projects.
- `POST /api/remixes`: creates a strictly validated project containing only source
  identifiers, capability mappings and composition metadata.
- `GET|PUT|DELETE /api/remixes/:id`: reads, replaces or removes one project.
  Mutations require same-origin requests and definitions are capped at 128 KiB.
- `POST /api/agents`: `{name}` -> `{ok,agent:{id,name},token}`. This returns the
  pairing secret once; D1 stores only its hash. The token format is `id.secret`.
- `POST /api/agents/:id/revoke`: prevents subsequent polling and result updates.
- `POST /auth/login`: `{code}` -> `{ok,user:{email}}` and a secure session cookie.
  Wrong codes return 401; rate limits return 429 with `Retry-After`.
- `POST /auth/logout`: revokes the current session and clears the cookie.
- `GET /api/login`: authenticated requests redirect to `/`; other requests
  redirect to `/signup`. `GET /api/logout` supports optional legacy Access logout.
  `GET /health`: public liveness only.
- `POST /agent/poll`: Bearer pairing token; `{version,activeJobId?,snapshot?}` ->
  `{ok,settings,job:Job|null}`. Updates heartbeat and validated redacted snapshot,
  atomically leases at most one queued job to that agent. Busy heartbeats include
  `activeJobId` to renew only that lease; idle polls do not renew unclaimed work.
  Expired leases become
  failed, never automatically requeue a possibly executed call.
- `POST /agent/jobs/:id/result`: same agent authentication; `{result,snapshot?}`
  -> `{ok}`. Accept only that agent's active job. Results use the core Result
  envelope; success follows `result.ok`, with sanitized failure metadata.

`target.save` args: `{name,url,apiHosts:string[],staticHosts:string[],readPostPaths:string[],allowPrivate:boolean,allowHttp:boolean}`.
It replaces configurable allowlists without rebinding an existing origin; starter
API hosts remain protected. `target.remove` args: `{site}`; starter targets cannot
be removed. `operation.remove` args: `{site,operation}`; only learned operations
can be removed. `sync` args: `{}`. Management operations use the same private
state and audit expectations as the engine, and never remove sessions/captures.

## Delivery boundaries and acceptance

The browser engine runs on ruOS or an explicitly paired desktop, not inside an
edge isolate. A sleeping/offline desktop is shown as offline; queued jobs stay
queued. Manual login opens a window on the agent desktop. Secrets can be configured
there, while the console shows readiness only. The agent defaults to refusing
private-network targets unless its local configuration explicitly permits them.

Acceptance covers desktop/mobile navigation, real target changes and discovery
through the paired agent, schema views and export, operation invocation, settings
persistence, signed-owner auth, origin checks, token revocation, lease ownership,
and safe credential handling. The Cloudflare deployment and npx agent are tested
after publication. Rollback restores the prior Worker build; agent pairing may
be revoked without removing private browser state.

## Deploying code sign-in

Build the root package, then run `npm ci --ignore-scripts`, `npm run check` and
`npm test` in `console/`. Apply all migrations in filename order, including
`0002_sessions.sql`. Set `OWNER_EMAIL` to your workspace owner identity. Store
the lowercase SHA-256 hex digest of your access code in the Worker secret
`CONSOLE_CODE_HASH` before enabling sign-in. Deploy `dist/worker.mjs` using
`wrangler.jsonc` and D1. A Cloudflare Access policy intercepting `/api/*` must
be removed or adjusted for the application code session to reach the Worker.

The code is checked only by the Worker; the browser bundle has no configured
code or hash. Desktop pairing and its separate revocable tokens are unchanged.
