# Version 0.2.0 verification

The management extension was verified on **2026-10-14** through ruOS Work
Desktop using Node **24.19.0**, installed Google Chrome, actual Miniflare/workerd
D1, and the deployed Cloudflare Worker. Executor responses were accepted only
with `completionVersion:1`, `completionVerified:true`, `status:"ok"` and `exitCode:0`.

| Requirement | Evidence |
| --- | --- |
| Existing network CLI/MCP behavior and new desktop agent | **68 core tests passed**, with zero skips. Includes private-target policy, registry replacement/removal, durable execution receipts, response redaction, heartbeat renewal and uncertain-result handling. |
| Cloud management API and private owner access | **15 Worker tests passed** against real workerd/D1. RSA-signed Access JWT tests reject wrong owner/issuer/audience/expiry; mutations require same-origin requests. |
| Agent pairing and job lifecycle | Tests cover hashed-only pairing secrets, revocation, atomic leases, busy/idle lease recovery, cancellation, result ownership and separate desktop state. |
| Desktop and mobile management | **1 full browser acceptance passed**, at 1440 px and 390 px, using the actual UI, Worker, D1 and paired engine. It registered a target, captured real Chromium traffic, inspected API endpoints, exported OpenAPI and persisted capture/motion preferences across reloads. |
| Animated visualizations and mobile layout | Data-backed SVG maps, selectable endpoint groups, a vertical mobile topology, reduced-motion handling and no horizontal page overflow were checked. Screenshots were visually reviewed. |
| Dependencies | Root and console lockfile audits report **0 vulnerabilities**. Dev-tool transitive fixes pin `sharp@0.35.5` and `undici@7.30.0`; runtime production dependencies remain pinned. |
| Deployed access boundary | Public HTML/health succeeded; unauthenticated management requests redirect to Cloudflare Access; unpaired agent requests return 401. The ruOS pairing token stays in a 0600 local file, while D1 stores its SHA-256 hash. |
| Live cloud-to-desktop execution | A job queued in deployed D1 ran through the authenticated ruOS agent, captured `https://example.com`, and synchronized its inferred network inventory successfully. |

Source checks: `npm run check`, `npm test`; console checks: `npm run check`,
`npm test` after building the root package. Artifact verification uses
`scripts/verify-artifact.mjs`. Cloud links and exact release hashes are recorded
in RELEASE.json after publication.

Website credentials and raw captures stay on the paired desktop; redacted
metadata/results and inferred schemas are synchronized to the cloud. The
desktop must remain awake and the agent running to execute jobs. Queued work
waits while it is offline. Manual login opens its browser there. No live
Product Hunt, Reddit or LinkedIn authenticated account access was asserted.
The network and read-policy limits described in the README still apply.

The previous release evidence is retained under `docs/releases/`.

Post-publication checks verified the exact npm tarball integrity, fresh-cache
`npx` console/sites/version commands, and the published MCP tools, calls and
resource. All 68 core tests also passed on minimum Node 22.13.0. The ruOS desktop
restarted during verification; its GNOME startup hook automatically reconnected
the agent running the published 0.2.0 package, with its prior capture intact.
