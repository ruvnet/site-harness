# Site Harness

A network-layer reverse engineer for arbitrary websites, exposed as an npx CLI
and stdio MCP server. Point it at a URL to discover the page's HTTP/API requests,
infer REST and GraphQL payload schemas, export an OpenAPI draft, and learn
selected requests as reusable operations. Product Hunt, Reddit and LinkedIn
are starter adapters. No model API key is required.

![Animated network discovery flow: browser requests become an endpoint inventory, inferred API contracts, and reusable CLI or MCP operations.](https://raw.githubusercontent.com/ruvnet/site-harness/main/docs/network-flow.svg)

The real `metaharness@0.4.17` factory generated the retained baseline;
`@metaharness/kernel@0.1.0` dispatches every CLI/MCP invocation using an exact
tool capability and site resource. `doctor` reports the actual kernel backend.
This build uses the portable JS backend; native and WASM backends are not
required. The network policy remains an application-level check.

## Discover a website

```sh
npx @ruvnet/site-harness@0.2.0 discover 'https://your-site.example/search?q=alpha' --site demo
site-harness network demo cACTUAL_CAPTURE_ID
site-harness openapi demo cACTUAL_CAPTURE_ID --output ./demo-openapi.json
```

Replace the example URL and capture ID with your target and the returned ID.
Discovery reports endpoint methods and paths, query/body parameter types,
response schemas, GraphQL operations, observed authentication references, and
blocked destinations. It stores the private capture locally and returns
metadata without credential values or raw request headers/bodies. Schemas
are inferred from observed samples, not verified server contracts.

Separate API origins and asset CDNs can be registered explicitly:

```sh
site-harness register demo https://your-site.example \
  --api-host api.your-site.example --static-host cdn.your-site.example \
  --read-post /api/search
site-harness discover https://your-site.example --site demo
```

Use the blocked-request inventory to identify additional hosts before adding
them. A fresh public HTTPS site needs no adapter. Apex and `www` aliases are
recognized; other origins remain explicit. Private or local sites need
`--allow-private true`; HTTP additionally needs `--allow-http true`. Browser
discovery loads the page without clicking buttons or filling forms. Manual
login is available for pages needing an account.

Discovery can observe page-initiated POST requests. Direct replay of a generic
POST requires a declared read path; known action endpoints and GraphQL mutation
documents are refused. Review the endpoint semantics before declaring a POST
as a read. Opaque binary bodies, WebSockets and encrypted application payloads
are marked unmodeled. One visit observes only the requests that page makes.
Large inventories/contracts are saved as complete redacted local artifacts
when they exceed the inline output budget.

## Run from source

Requires Node **22.13+**. The lockfile pins the complete installation.

```sh
npm ci --ignore-scripts
npm run build
node dist/src/cli.js sites
node dist/src/cli.js ops linkedin
```

State defaults to `~/.site-harness`. On this restricted workspace, set
`SITE_HARNESS_HOME=/workspace/site-harness/.state` when launching the command.

## Run with npx

Use the versioned package:

```sh
npx @ruvnet/site-harness@0.2.0 discover https://your-site.example --site demo
npx @ruvnet/site-harness@0.2.0 mcp
```

For local artifact testing, build a tarball and run those exact bytes:

```sh
npm pack
npx --yes --package ./ruvnet-site-harness-0.2.0.tgz site-harness sites
npx --yes --package ./ruvnet-site-harness-0.2.0.tgz site-harness mcp
```

The reviewed npm tarball contains compiled runtime code and its shrinkwrap;
consumers do not need the development compiler. Existing MCP host configuration
is not changed automatically.

## Starter adapters

| Site | Operations | Access |
| --- | --- | --- |
| Product Hunt | `posts`, `post`, `comments`, `topics` | `PRODUCTHUNT_TOKEN`, official GraphQL with public scope |
| Reddit | `search`, `posts`, `post`, `comments`, `subreddit` | Approved `REDDIT_ACCESS_TOKEN` with read scope and descriptive `REDDIT_USER_AGENT` |
| LinkedIn | `getMe`, `getProfile`, `getCompany`, `searchPeople`, `searchCompanies` | Your own manually created local browser session |

`ops <site>` gives the full parameter schemas. Native API connections preserve
their pagination cursors. Product Hunt's `posts` are launches; its official API
has no full-text product search. LinkedIn recipes use private Voyager endpoints,
can drift, and return only the first ten search results. Reddit comment trees
preserve `more` placeholders; they are not automatically expanded.

Provide credentials in the launching environment. The CLI does not load `.env`
automatically, exchange passwords, mint OAuth tokens, or import your everyday
browser profile. `.env.example` lists the variable names.

```sh
site-harness call producthunt posts first=10 order=NEWEST
site-harness call producthunt post slug=example-launch
site-harness call reddit search query=typescript limit=10
site-harness call reddit posts subreddit=typescript sort=new limit=10
site-harness login linkedin
site-harness call linkedin getProfile publicId=your-profile-slug
```

`login` opens a visible Chromium window. Sign in manually and close the window
to save the session. Chrome, Chromium, Brave and Edge are supported; choose an
existing executable with `API_ANYTHING_BROWSER` if needed. No browser is
downloaded at runtime. CLI results are JSON; failures exit with status 1 and
include a failure class and suggested next step.

## Connect MCP

Start `site-harness mcp`. Stdout contains only MCP protocol messages.
The fourteen tools are:

`register_site`, `discover_site`, `network_inventory`, `export_openapi`,
`list_sites`, `list_operations`, `call_operation`, `capture_page`,
`inspect_capture`, `learn_operation`, `repair_operation`, `export_site`,
`login`, and `doctor`.

Use `list_operations` before calling an operation. `examples/mcp.json` and
`examples/codex-config.toml` connect to the versioned npm package.
Adjust the state path for your machine and pass credential
environment variables through your MCP host. For a source checkout, a server
can instead use `node /absolute/path/site-harness/dist/src/cli.js mcp`.
Do not overwrite your existing host configuration with an example file.

## Learn another read workflow

The browser records two distinct inputs; the engine identifies parameter slots,
separates session references, and persists a reusable operation. Any registered
website and its declared API hosts are accepted. Navigation and bounded waits are supported;
action clicks, form fills, posts, votes and messages are refused.

```sh
site-harness capture reddit 'https://www.reddit.com/search/?q=sqlite' query=sqlite
site-harness capture reddit 'https://www.reddit.com/search/?q=postgres' query=postgres
site-harness inspect reddit cFIRST 1 --response '{"extract":"data.children","pick":["title=data.title"]}'
site-harness learn reddit browserSearch \
  --trigger 'https://www.reddit.com/search/?q={query}' \
  --example '{"query":"sqlite"}' --example2 '{"query":"postgres"}' \
  --from cFIRST --from2 cSECOND --request-id 1 \
  --response '{"extract":"data.children","pick":["title=data.title","url=data.permalink"]}'
site-harness call reddit browserSearch query=duckdb
```

The request ID, extraction recipe and capture IDs above are placeholders:
inspect the actual captured responses and choose their real fields. Modern
Reddit pages may use HTML, embedded data or a different API response; the tool
does not assume every page has the illustrated JSON endpoint. Omitting `from`
and `from2` captures the trigger with both examples automatically. Use a fresh
third input to verify the learned operation. Official operation names cannot
be replaced by learned recipes.

`learn_operation` accepts the same fields as the CLI: `site`, `operation`,
two `examples`, optional `trigger`, `match`, `response`, `from`, `from2`, and
`requestId`. A response recipe can select JSON `extract`/`pick` fields, HTML
`items`/`fields`, or an `embedded` object containing a `regex`. The engine
tries direct HTTP first, then guarded Chromium replay when needed, and repairs
drift only after a successful validation. Challenges may require manual login.

## Local data and policy

Captures and sessions contain private cookies or tokens and are saved with
restrictive filesystem permissions. Specifications store references to those
values; credential-free exports are checked before returning. The audit log
records action, site, operation, outcome and duration, without arguments or
response contents. Treat website text as untrusted data.

HTTP and browser requests are gated by registered destinations. GraphQL read
operations are parsed; mutations are denied, while unknown persisted operations
require an explicitly declared read path.
Redirects are checked, action requests are blocked, and unrelated destinations
are refused. These checks are application policy, not a general Chromium
sandbox and not proof that every site's GET or declared POST read endpoint is
side-effect-free. Public-target DNS preflight catches private address resolution
at check time; it does not pin Chromium's connections against DNS rebinding.
Static asset allowlists are narrow and may need maintenance when sites change.

Tokens, an authenticated desktop session, and access granted by a service may
be required for protected calls. Inference limits do not cap every upstream
browser response before it is buffered. The offline tests use synthetic fixtures;
they do not establish that these services accept your account or network.

## Development and evidence

```sh
npm run check
npm test
npm pack --dry-run
```

Tests exercise native API contracts, learning from two captures, an unseen-input
replay, session-reference storage, privacy, request policies, CLI failure status,
MCP initialization and actual stdio transport. Restricted runners must grant
subprocess execution for CLI/MCP acceptance tests; otherwise those tests fail
explicitly. See `docs/IMPLEMENTATION.md` and `docs/VERIFICATION.md` for provenance
and the release evidence. Upstream MIT licenses are retained.

## Management console

Open [Site Harness Console](https://site-harness-console.cognitum-consulting-mail.workers.dev)
on desktop or mobile. Use the workspace access code `ruvnet` on the branded
[sign-in page](https://site-harness-console.cognitum-consulting-mail.workers.dev/signup).
No email code is needed. Sign-in shares the dashboard design and supports desktop
and mobile. The console
includes animated network maps, endpoint and schema inspection, OpenAPI downloads,
target allowlists, learned operation controls, job history, capture preferences,
reduced motion, and desktop pairing/revocation.

The cloud coordinates jobs; a paired desktop runs Chromium and keeps website
cookies, raw captures and API tokens local. An offline desktop is shown as
offline, and its jobs wait in the queue. In Settings, pair a desktop and download
its private configuration. On macOS or Linux, restrict the file before starting:

```sh
chmod 600 ./site-harness-agent.json
npx @ruvnet/site-harness@0.2.0 agent --config ./site-harness-agent.json
```

Keep the agent running while using the console. Manual login opens a browser on
that desktop. Cloud settings control capture timeout, static request inclusion,
refresh and animation; local configuration controls private-network permission.
The deployed ruOS agent starts with the desktop session and uses separate private
state. Credentials for starter adapters remain in its launching environment.

Console source, migrations and pinned build dependencies live in `console/`.
Run `npm ci --ignore-scripts` there, then `npm run check` and `npm test` after the
root package is built. See [management architecture](docs/MANAGEMENT.md).

Release artifact verification also installs the tarball into a temporary project
and exercises npx discovery, OpenAPI file output, and MCP tools, calls and resources:

```sh
node scripts/verify-artifact.mjs ./ruvnet-site-harness-0.2.0.tgz
```
