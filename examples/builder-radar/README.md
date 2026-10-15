# Builder Radar

Live: https://builder-radar.cognitum-consulting-mail.workers.dev

A Reddit inspired discovery interface combining Product Hunt launches, Reddit r/SideProject discussions and Fireship YouTube videos. Every entry comes from a real Site Harness capture. No sample posts or invented votes.

## Acquisition

The collector imports @ruvnet/site-harness 0.2.0 and uses discover_site followed by inspect_capture. It runs on the Software Factory ruOS desktop with Node 22.18.0 and Chrome. Site Harness doctor currently reports an older 0.1.0 version string; the installed npm package is 0.2.0.

Product Hunt and Reddit use their public Atom feeds, 25 entries each. YouTube uses the public @Fireship/videos HTML document and a projected ytInitialData extraction, up to 12 videos. The tested channel RSS endpoints returned 404, so no RSS success is claimed. Publication dates unavailable from the selected YouTube fields remain null; capture times are not substituted as publication dates.

Product taglines and media references are selected from actual captures. Product Hunt page metadata supplies preview images and YouTube embeds when exposed, with at most two product page captures per cycle, an eight second capture limit and a 24 hour local media cache. HTTP 403 or 429 pauses product page enrichment for 24 hours while retaining previously captured previews. Product Hunt currently blocks fresh page previews; its public feed remains available. Reddit media is extracted from captured feed content. Raw private captures, cookies and headers stay on the desktop. Only selected public fields enter the signed snapshot.

## Experience

The default paired feed puts launches beside up to two Reddit discussions. Matching uses explicit title phrases, shared terms and declared topic dictionaries. Reasons are visible; topic matches are inferences, not product reviews, endorsements or evidence of demand. Unmatched products remain visibly unmatched. The media shelf shows independent Fireship videos, not purported product reviews. Source filters, newest sorting, compact mode, browser-local saves and comparisons remain available.

Images load lazily. YouTube players use youtube-nocookie.com and are created only when clicked. Captured direct Reddit MP4 links can use native controls when present. Other native or restricted video formats remain accessible through original source links. An original-source link remains below every player. Embedding and thumbnail delivery remain controlled by their upstream hosts. No assertion is made that every source post includes media or that every video permits embedding.

## Refresh and persistence

A ruOS task runs every five minutes under flock. The browser reloads snapshots every minute. Source failures retain prior items with Stale status; captures older than 15 minutes are marked stale. This depends on the desktop executor and source availability, not a push stream. KV propagation can introduce additional latency.

The collector signs snapshots with a local P-256 private key. The Cloudflare Worker verifies against the configured public JWK and stores snapshots in the SNAPSHOTS KV binding. The public JWK in worker.mjs is not secret. Private keys must never be committed.

## Run and deploy

Install the pinned package.json dependencies with npm install --ignore-scripts on Node 22.13 or newer. Supply an existing Chrome installation. Generate a P-256 PKCS8 key at ingest-private.pem with mode 0600 and configure the corresponding public JWK in the Worker. Deploy worker.mjs as an ES module with compatibility date 2026-10-01 and SNAPSHOTS bound to a dedicated KV namespace. Adapt the collector's fixed ingest URL for a separate deployment. Run npm run collect.

## Security and verification

The Worker caps ingress at 100 KB, verifies signatures, rejects old snapshots and validates source URLs, media hosts and video IDs. CSP permits images only from enumerated media hosts and frames only from youtube-nocookie.com. Imported text is escaped. No arbitrary URL fetch endpoint is exposed.

Local checks cover syntax, routes, missing data, unsigned ingestion, unrelated-match rejection, topic labels, valid media and malicious media rejection. Real ruOS executions verified capture, extraction, signing and upload of all three sources in a 62 entry snapshot: 25 Product Hunt launches, 25 Reddit posts and 12 YouTube videos. Captured media included one Product Hunt image, eight Reddit images and twelve YouTube thumbnails and video IDs. Player rendering and playback require browser acceptance; upstream embedding restrictions can still apply.

Acceptance: /api/feeds must name @ruvnet/site-harness, expose source capture IDs and media provenance, and show available source counts. Click a video to create a player, close it to stop playback, and open its original source if embedding is blocked. Verify a later scheduled capture advances source timestamps.
