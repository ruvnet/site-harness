# Implementation and acceptance contract

The user outcome is a published npm package, an npx binary and a stdio MCP server
that reverse-engineers arbitrary registered websites at the network layer.
Scope includes target registration, discovery, endpoint/schema inventory,
OpenAPI export, capture, inspect, learn, call, repair and manual login. Product
Hunt, Reddit and LinkedIn provide starter examples. Posting and messaging are
not exposed. Publication is authorized through ruOS.

## Specification and control flow

Validate the tool and its arguments before transport. Select an official API
operation when one exists, otherwise resolve a validated learned operation.
Record a private audit start, enforce the selected site's request policy,
perform a bounded call, redact outputs, classify failure, and record the result.
Missing credentials and invalid input cause no network request. Auth and rate
failures have no blind retry.

Learning validates two distinct examples, captures guarded browser requests or
loads two local captures, removes aborted and unapproved exchanges, identifies
parameter slots and credential references, then stores the operation. Subsequent
calls fill slots and validate replay. Reactive repairs are promoted only when
the engine's replay checks pass.

## Architecture

- `src/cli.ts`: npm binary and JSON result/status interface.
- `src/mcp.ts`: actual MCP SDK protocol, dynamic JSON Schema and stdio transport.
- `src/service.ts`: shared dispatch, validation, envelopes and private audit.
- `src/harness.ts`: real MetaHarness capability dispatcher and kernel validation.
- `src/adapters`: fixed official Product Hunt and Reddit API contracts.
- `src/engine.ts`: serialization, session isolation, safe capture/learn wrapper.
- `src/policy.ts`: exact site origins, read-only GraphQL AST policy and redaction.
- `src/targets.ts`: generic origin registration and declared POST read paths.
- `src/network.ts`: observed endpoint groups, inferred schemas and OpenAPI drafts.
- `vendor/api-anything`: pinned MIT core and five LinkedIn recipes.
- `.harness`: MetaHarness scaffold and generator provenance.

The original generated baseline is retained intact under `.harness/generated`,
including its original manifest and hashes. The customized runtime policy is
`.harness/runtime-policy.json`; generator choices and verified npm tarball
integrity are in `.harness/provenance.json`. Regenerate a separate baseline with
`scripts/regenerate-harness.mjs` and the reviewed published generator module.
The factory is a development tool, not a runtime dependency: its unrelated
autonomous model packages are not installed by this application.

The pinned MetaHarness kernel's real ToolDispatcher is used for every invocation.
The host issues an exact per-tool/per-site claim for each authorized local call;
callers cannot supply their own claims. This does not replace host authentication
or the separate network checks. The local stdio transport relies on process and
filesystem permissions. `doctor` loads the real kernel and validates its server
spec; the tested portable backend is JS.

The factory scaffold is customized into a focused application. Model execution
stays with the host. The deterministic operation learner does not invoke an LLM.
Official APIs were selected for stable supported reads; learned private endpoints
are retained for LinkedIn and user-defined workflows. A remote HTTPS service would
require a separate authenticated deployment; this deliverable uses local stdio.

## Trust boundaries and remaining limits

Tool arguments are schema-checked. Official queries are static and inputs are
variables. Website text never becomes instructions or executable code. Tokens
reside in process environment or private state, without transfer to another
service. Browser imports are disabled; login is an explicit visible window.
The package exposes no shell tools or write operations. Captures and sessions
require local disk writes; the filesystem permissions and process identity
remain the operating system's boundary.

Origin allowlists prevent requests to unregistered hosts. Private literals and
current DNS resolution are checked by default; private targets require explicit
opt-in. This is not connection-level DNS pinning or a Chromium sandbox. Read policies cannot establish
all server semantics. Bot challenges, unrecognized GraphQL encodings, unsupported
asset hosts, consent restrictions and endpoint drift can cause a clear failure.
Live account access remains to be verified with the owner's credentials.

Rollback means stop the local MCP process and remove the package. Private session
state remains under SITE_HARNESS_HOME until its owner deletes it. There is no
remote deployment or schema migration.
Discovery does not require a site adapter. It captures initial page traffic,
including generic page-initiated POST requests, and reports unknown/blocked
API origins for explicit registration. A read declaration is needed before
replaying an otherwise unknown POST. Learning remains deterministic, requires
two distinct examples, and validates an unseen call in the acceptance fixture.
WebSockets and opaque bodies are reported as unmodeled rather than interpreted.
