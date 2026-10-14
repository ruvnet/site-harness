# Release verification

Version: `@ruvnet/site-harness@0.1.0`. Verified on **2026-10-14** through ruOS
Work Desktop, using Node **24.19.0**, pinned dependencies, and installed Google
Chrome. Remote commands returned executor-owned `completionVersion: 1`,
`completionVerified: true`, `status: "ok"`, and `exitCode: 0`.

| Check | Evidence |
| --- | --- |
| TypeScript | `npm run check` completed successfully. |
| Complete test suite | `npm test`: **54 passed, 0 failed, 0 skipped**. |
| Generic browser discovery | Real Chromium visited a local HTTP fixture with explicit private/HTTP flags; captured GET and POST API traffic, exported OpenAPI, and blocked an action POST before transport. |
| Learn and replay | Two distinct browser examples produced a read operation; a third input returned the expected response, including a custom-port POST read endpoint. |
| REST and GraphQL inference | Endpoint grouping, payload schemas, GraphQL operations, auth reference metadata, redaction, and multi-origin OpenAPI merging passed fixture checks. |
| Official starter adapters | Product Hunt and Reddit contract, pagination, input, credential, error and rate-limit cases passed injected transport tests. LinkedIn recipes passed local contract and session-reference checks. |
| MetaHarness | The published `metaharness@0.4.17` scaffold was generated with verified npm integrity. Real `@metaharness/kernel@0.1.0` dispatch and capability rejection passed tests; `doctor` validated the actual portable JS backend and MCP specification. |
| CLI and MCP | Source CLI failure status, real SDK initialization/calls/resources, and stdio subprocess transport passed. All **14** MCP tool schemas were exposed. |
| Installed npm artifact | `scripts/verify-artifact.mjs` installed the packed tarball in an isolated temporary project and exercised actual npx registration, Chromium discovery, OpenAPI file output, and MCP tools/calls/resources. |
| Package contents | Reviewed tarball includes compiled runtime, shrinkwrap, retained licenses/provenance, and animated README SVG. Captures, sessions, profiles, credentials, node_modules, and tests are excluded. |
| Dependency audit | `npm audit --omit=dev --json`: **0 reported vulnerabilities**. Full result is [npm-audit.json](npm-audit.json). |

To reproduce the source and artifact checks:

```sh
npm ci --ignore-scripts --omit=optional
npm run check
npm test
npm audit --omit=dev
npm pack
node scripts/verify-artifact.mjs ./ruvnet-site-harness-0.1.0.tgz
```

An installed Chromium browser is required for browser and artifact acceptance.
The source browser test explicitly reports a skip if no supported executable
exists; the artifact check fails without a working browser. No credentials or
live account data were used in the fixtures. These results establish local
behavior; they do not establish live Product Hunt, Reddit or LinkedIn account
access. An authenticated browser session or official API token is needed where
the target requires one.

Discovery reflects observed page traffic, and inferred OpenAPI documents are
drafts. WebSocket/binary payloads remain unmodeled. Destination and read policies
are application checks, including DNS preflight; they do not pin browser DNS
connections or prove every server endpoint is side-effect-free. See the README
for operational limits and [IMPLEMENTATION.md](IMPLEMENTATION.md) for architecture.
