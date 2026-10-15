# Builder Radar

Live: https://builder-radar.cognitum-consulting-mail.workers.dev

A standalone Cloudflare Worker example inspired by Product Hunt and Reddit. Zero runtime dependencies. It does not run the Site Harness desktop agent; it uses equivalent official read APIs directly for optional live data.

## Features

20 editorial starter entries, text search, topic filters, sorting, browser-local saved IDs, three-tool comparisons, source research links, responsive layout, reduced-motion support, source status and optional live APIs.

Starter descriptions and research links are not verified launches, reviews, demand matches or endorsements. No votes or popularity scores are fabricated. Live Reddit results are unverified search matches. There is no shared account system, voting, posting or automated matching in this version.

## Deploy

Deploy worker.mjs as an ES module Worker named builder-radar with compatibility date 2026-10-01. Enable its workers.dev route. The deployed source is this file without a build step.

## Optional secrets

Set PRODUCTHUNT_TOKEN for official GraphQL reads. Set an approved REDDIT_ACCESS_TOKEN and descriptive REDDIT_USER_AGENT for Reddit OAuth reads. Never commit credentials. Reddit tokens must be refreshed externally; no OAuth refresh flow is included. Missing credentials return explicit 503 JSON; upstream failures return 502. Status reports configuration, not successful upstream validation.

Before enabling tokens on a busy public deployment, add request rate limiting and short-lived shared caching to protect upstream quotas. Current deployment has no source tokens and generates no upstream API traffic. Saved tool IDs remain in the browser and do not sync across devices. Loading live launches replaces the current feed until reload.

## Verification

Node syntax and 12 route/content/security-header/input-validation/fixture checks passed on 2026-10-15. Fixtures test mapping and failure handling, not acceptance by the real source accounts. Browser visual QA and live authenticated API acceptance remain unverified.

## Security boundary

Read-only fixed upstream origins; no arbitrary URL proxy. Eight-second source timeout. Search input capped at 200 characters. External links limited to HTTPS, escaped rendered data, restrictive CSP, no framing, no credentials returned to clients. No dependencies or package execution required. API content is untrusted data.
