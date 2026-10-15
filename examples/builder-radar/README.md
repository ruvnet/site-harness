# Builder Radar: real Site Harness network demo

Live: https://builder-radar.cognitum-consulting-mail.workers.dev

## Data path

Public Product Hunt Atom feed and Reddit r/SideProject Atom feed → @ruvnet/site-harness 0.2.0 on ruOS → discover_site network capture → inspect_capture structured extraction → ECDSA signed snapshot → Cloudflare Worker → KV → browser.

No sample entries and no direct upstream fetches in the Worker. Source titles, URLs and publication timestamps come from the actual capture. Descriptions are generic labels, not extracted reviews or sentiment. Each entry includes capture ID, request ID and fetch timestamp. Click Inspect pipeline to inspect source status and provenance.

## Runtime

collector.mjs imports the actual SiteHarness service. It runs with Node 22.18.0 and system Chrome in an isolated state directory on the Software Factory ruOS desktop. Package 0.2.0 currently reports 0.1.0 in its doctor output; the installed package version is the version shown in this demo.

The ruOS recurring task runs every five minutes using flock to prevent overlap. The browser reloads the latest snapshot every minute. This is polling, not push streaming, and feeds can publish on their own cadence. The task depends on the ruOS executor; stale data is labeled after 15 minutes. Source blocks and failures retain the last snapshot with Stale or Unavailable status. Reddit source scope is r/SideProject only. No anti-bot bypass or private API extraction.

The initial end-to-end collector run on 2026-10-15 captured 25 entries from each source, both HTTP 200, and successfully published its signed snapshot. Initial capture IDs: Product Hunt cmv95yjie, Reddit cmv95ym5p. Later runs replace these IDs.

## Deployment

Deploy worker.mjs as a Cloudflare ES module, compatibility date 2026-10-01. Bind SNAPSHOTS to a dedicated KV namespace. Generate an ECDSA P-256 key on the collector machine, store its PKCS8 PEM at ingest-private.pem with mode 0600 and set the matching public JWK in worker.mjs. Never publish the private key. The public key checked into this deployment is not a credential and cannot authorize uploads.

Install @ruvnet/site-harness@0.2.0 with lifecycle scripts disabled. Use a supported Node version and an existing Chrome installation. Run collector.mjs from its isolated directory. It keeps a private local snapshot and purges capture files older than 24 hours after successful publication. Raw captures, cookies and headers never enter the public snapshot.

The Worker validates the signature, snapshot age, item count, allowed source URLs, capture IDs and request IDs before ingestion. Snapshot bodies are capped at 100 KB. Older snapshots are rejected. KV is eventually consistent, so updates can take additional time to appear globally. The browser escapes imported text and accepts only HTTPS links.

## Acceptance

GET /api/feeds must identify engine @ruvnet/site-harness, contain real items from both sources and include capture IDs, request IDs and fetch timestamps. GET /api/status exposes per-source availability. POST /api/ingest without a signature must return 401. The homepage must expose Inspect pipeline. After the next successful scheduled run, capture timestamps and IDs must advance.

Local checks cover JavaScript syntax, route behavior, missing snapshots, invalid payloads and unsigned ingestion. Live collector execution verifies the capture, extraction, signing and upload path. Browser visual QA has not been performed. Search is local to captured entries; related Reddit lookup is a title match within captured posts, not a global search or verified relationship. Saved IDs remain in the browser. No shared voting, accounts or comment mirroring.
