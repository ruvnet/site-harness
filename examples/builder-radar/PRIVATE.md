# Private authenticated capture

Private workspace: https://builder-radar-private.cognitum-consulting-mail.workers.dev/private/

The private Worker uses a separate KV namespace, signing key and browser state directory. Cloudflare Access allows only ruv@cognitum.one and ruv@ruv.net. These are aliases for the same owner workspace. JWT signature, issuer, audience, expiry and owner identity are checked again by the Worker. A caller cannot choose a tenant through a URL or request header. Adding another person requires a separate tenant, signing key, capture home and explicit identity policy; this is not open signup.

The existing public collector retains its isolated unauthenticated state. Private envelopes are explicitly rejected by the public validator. The private ingest key is not accepted by the public Worker. No browser passwords, cookies, raw headers or complete capture files are uploaded. Private content is rendered as text without third party embeds or image requests. Original source links open only on click.

## Deployment

Worker: builder-radar-private. PRIVATE_SNAPSHOTS binds only the private KV namespace. INGEST_PUBLIC_KEY is the public P256 JWK for this owner. The corresponding private key remains on the ruOS desktop with mode 0600. Snapshots expire in KV after 24 hours and responses use private, no-store. Do not add the public SNAPSHOTS binding to this Worker or private storage to the public Worker.

Cloudflare Access protects /private on the private hostname. /ingest is outside the browser login route and requires an ECDSA signature over the complete body, including visibility and tenant. Signed messages must be generated within five minutes; older stored snapshots are rejected. KV is eventually consistent, so concurrent writers are not supported. Run capture and publish serially under flock. This demo is not a transactional queue.

## Connect from the app

Open the private workspace and choose Connect Reddit, Connect YouTube or Connect Product Hunt. Open the capture desktop using the displayed link, complete login in that desktop window, then close the window to save the session. Status distinguishes queued, opening, session saved and failed. Session saved does not establish a successful authenticated capture; an approved source recipe is still needed.

The owner authenticated POST requires a same origin JSON request. A dedicated desktop bridge polls signed requests and can start only the three fixed login commands. It accepts no shell commands from the UI. Jobs are bounded, deduplicated locally, and serialized by the single desktop process. KV propagation can delay a window by up to a minute. The desktop viewer is a secret Worker binding and is returned only to the owner. Its control session expires after at most one hour; a new control session and bridge run are required afterward. Expired controls are disabled. No source passwords or session cookies pass through the queue.

Twenty two security and UI structure tests pass. The signed bridge poll succeeds on production; real account login remains a manual acceptance step.

## Advanced setup on Software Factory

The runtime is installed at /home/ruv/builder-radar-harness. Node 22 is pinned locally. Use its dedicated browser profile rather than importing another application's sessions.

```sh
cd /home/ruv/builder-radar-harness
./node_modules/node-linux-x64/bin/node private-collector.mjs login reddit
# Or login producthunt / login youtube
```

Complete the source's login manually in the visible desktop window, then close the window to save the session. Never paste credentials into a recipe or chat. Saving a session does not prove the requested page is authenticated. Source restrictions and account challenges still apply; do not bypass them.

Capture a page you are authorized to read:

```sh
./node_modules/node-linux-x64/bin/node private-collector.mjs discover reddit 'https://www.reddit.com/'
```

The collector saves a redacted discovery inventory locally at private-ruv/reddit-discovery.json. Raw captures and session state stay under private-ruv/state with private filesystem permissions. Inspect the actual page's capture and select its real request ID and response fields. No universal saved posts or subscriptions schema is claimed. Modern site schemas require a tested recipe for the account page.

Create a private local recipe file from the actual capture. The following is a structure example, not a working Reddit schema:

```json
{
  "visibility": "private",
  "ownerApproved": true,
  "source": "reddit",
  "capture": "cACTUAL_CAPTURE_ID",
  "requestId": 1,
  "response": {
    "format": "json",
    "extract": "ACTUAL_ARRAY_PATH",
    "pick": ["title=ACTUAL_TITLE_FIELD", "url=ACTUAL_URL_FIELD", "description=ACTUAL_TEXT_FIELD"]
  }
}
```

Only title, url and optional description projections are accepted. The collector generates stable IDs and adds provenance from its stored discovery. Source links are restricted to the selected service; query parameters are removed except validated YouTube video IDs. Review selected content before setting ownerApproved. Field allowlisting cannot determine whether an approved text field itself contains sensitive information.

```sh
flock private-ruv/collector.lock ./node_modules/node-linux-x64/bin/node private-collector.mjs publish reddit /absolute/path/approved-recipe.json
```

Each publish replaces the private snapshot with the selected capture, up to 75 entries. Private automatic polling is not enabled. The public five minute schedule is unchanged. Local private capture retention is manual in this first version; remove private-ruv/state to erase sessions and captures when disconnecting. Deleting browser sessions does not delete the existing KV snapshot; remove tenant:ruv:latest using the Cloudflare dashboard or wait for its 24 hour expiry. Revoke Access sessions through Cloudflare when needed.

## Verification and limits

Run `node --test private.test.mjs`. Tests cover owner JWT verification, expiry, issuer, audience, tampering, algorithm substitution, tenant isolation, signed ingestion, replay, private/public scope separation and field projection. Synthetic fixtures are never production account data. Live anonymous and forged identity requests must not return private content.

Authenticated source capture and the owner browser login require a real manual session. They are not claimed verified until the owner signs in and a source specific recipe is tested. Acceptance: sign in to the private workspace, publish one permitted real account capture, confirm it is readable there, then verify an anonymous browser and the public feed cannot retrieve it.
