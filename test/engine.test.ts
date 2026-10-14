import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  API_ANYTHING_COMMIT, EngineError, callLearnedOperation, capture, configureEngine,
  engineDoctor, exportLearnedSite, inspect, learn, listLearnedOperations, setBrowserRequestPolicy,
} from "../src/engine.js";
import { browserRequestAllowed } from "../vendor/api-anything/src/browser.js";
import type { CaptureFile } from "../vendor/api-anything/src/heal.js";
import { reimportIfBrowser } from "../vendor/api-anything/src/login.js";
import { loadSession, saveSession, writePrivate } from "../vendor/api-anything/src/session.js";
import { parseSite } from "../vendor/api-anything/src/spec.js";
import { loadSite, saveSite } from "../vendor/api-anything/src/store.js";

const directories: string[] = [];
const SECRET = "fixture-session-d934b57ce184f680b9";

function freshHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "site-harness-engine-"));
  directories.push(directory);
  configureEngine({ home: directory });
  return directory;
}

function fixtureCapture(directory: string, id: string, query: string, extra: Partial<CaptureFile> = {}): CaptureFile {
  const url = `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`;
  const record: CaptureFile = {
    id, at: new Date().toISOString(), url, finalUrl: url, locations: [url],
    cookies: [{ name: "reddit_session", value: SECRET, domain: ".reddit.com", path: "/", expires: -1, httpOnly: true, secure: true }],
    exchanges: [{
      id: 1, resourceType: "fetch",
      request: {
        method: "GET", url: `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&raw_json=1`,
        headers: { accept: "application/json", cookie: `reddit_session=${SECRET}`, "x-csrf-token": SECRET },
      },
      response: { status: 200, contentType: "application/json", headers: { "content-type": "application/json" }, body: JSON.stringify({
        data: { children: [{ data: { title: `${query} result`, permalink: "/r/databases/comments/abc", access_token: SECRET } }] },
      }) },
    }],
    ...extra,
  };
  writePrivate(join(directory, "captures", `${id}.json`), JSON.stringify(record));
  return record;
}

afterEach(() => {
  setBrowserRequestPolicy(undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("two offline captures learn credential references and replay an unseen input", async () => {
  const directory = freshHome();
  fixtureCapture(directory, "cfirst", "sqlite");
  fixtureCapture(directory, "csecond", "postgres");
  const learned = await learn({
    site: "reddit", op: "search", trigger: { url: "https://www.reddit.com/search/?q={query}" },
    examples: [{ query: "sqlite" }, { query: "postgres" }], from: "cfirst", from2: "csecond", requestId: 1,
    response: { extract: "data.children", pick: ["title=data.title", "url=data.permalink"] },
  });
  assert.equal(learned.ok, true);
  assert.deepEqual(learned.captures, ["cfirst", "csecond"]);
  assert.equal(learned.operation.readOnly, true);
  assert.equal(learned.operation.minTier, 1);
  assert.deepEqual(learned.operation.params.map((param) => param.name), ["query"]);
  assert.equal(learned.preview && (learned.preview as { first: { title: string } }).first.title, "sqlite result");
  const specText = readFileSync(join(directory, "sites", "reddit.json"), "utf8");
  assert.equal(specText.includes(SECRET), false);
  const operation = loadSite("reddit")!.site.operations[0]!;
  assert.ok(operation.slots.some((slot) => slot.ref === "cookie:reddit_session"));
  assert.equal(loadSession("reddit").cookies[0]?.value, SECRET);
  for (const file of [join(directory, "sites", "reddit.json"), join(directory, "sessions", "reddit.json"), join(directory, "captures", "cfirst.json")]) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  let sent = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    sent++;
    const url = new URL(String(input));
    assert.equal(url.hostname, "www.reddit.com");
    assert.equal(url.searchParams.get("q"), "duckdb");
    assert.equal(new Headers(init?.headers).get("x-csrf-token"), SECRET);
    assert.equal(init?.redirect, "manual");
    assert.equal(browserRequestAllowed({ url: "wss://www.reddit.com/socket", method: "CONNECT", resourceType: "websocket" }), false);
    assert.equal(browserRequestAllowed({ url: "wss://www.reddit.com/socket", method: "SEND", resourceType: "websocket" }), false);
    assert.equal(browserRequestAllowed({ url: "https://www.reddit.com/api/submit", method: "POST", postData: "text=hello" }), false);
    return new Response(JSON.stringify({ data: { children: [{ data: { title: "DuckDB unseen", permalink: "/r/databases/comments/new" } }] } }), { headers: { "content-type": "application/json" } });
  };
  const result = await callLearnedOperation("reddit", "search", { query: "duckdb" }, { fetchImpl, maxTier: 1, minIntervalMs: 0 });
  assert.equal(sent, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [{ title: "DuckDB unseen", url: "/r/databases/comments/new" }]);
  const exported = exportLearnedSite("reddit");
  assert.equal(exported.spec.operations[0]!.params[0]!.example, undefined);
  assert.equal(JSON.stringify(exported).includes(SECRET), false);
});

test("inspection exposes structured recipe data and redacts credentials", () => {
  const directory = freshHome();
  fixtureCapture(directory, "cread", "sqlite");
  const result = inspect("reddit", "cread", 1, { extract: "data.children[0].data" });
  assert.deepEqual(result.data, { title: "sqlite result", permalink: "/r/databases/comments/abc", access_token: "[redacted]" });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("x-csrf-token"), false);
  assert.equal(serialized.includes("reddit_session"), false);
  assert.throws(() => inspect("linkedin", "cread", 1), (error) => error instanceof EngineError && error.code === "DESTINATION_REFUSED");
  assert.throws(() => inspect("reddit", "../cread", 1), (error) => error instanceof EngineError && error.code === "INVALID_CAPTURE");
});

test("unsupported sites, origins, insecure URLs and unsafe trigger actions fail before browsing", async () => {
  freshHome();
  await assert.rejects(capture("example", "https://example.com"), (error) => error instanceof EngineError && error.code === "UNSUPPORTED_SITE");
  await assert.rejects(capture("reddit", "https://www.linkedin.com/feed/"), (error) => error instanceof EngineError && error.code === "DESTINATION_REFUSED");
  await assert.rejects(capture("reddit", "https://www.reddit.com.evil.example/search"), (error) => error instanceof EngineError && error.code === "DESTINATION_REFUSED");
  await assert.rejects(capture("reddit", "http://www.reddit.com/search"), (error) => error instanceof EngineError && error.code === "INVALID_URL");
  await assert.rejects(learn({ site: "reddit", op: "search", examples: [{ query: "sqlite" }, { query: "postgres" }], trigger: { url: "https://www.reddit.com", steps: [{ action: "click", selector: "button" }] } }),
    (error) => error instanceof EngineError && error.code === "INTERACTION_REFUSED");
  await assert.rejects(learn({ site: "reddit", op: "search", examples: [{ query: "same" }, { query: "same" }], trigger: { url: "https://www.reddit.com/search/?q={query}" } }),
    (error) => error instanceof EngineError && error.code === "EXAMPLES_REQUIRED");
});

test("aborted and mutating captured requests cannot be learned", async () => {
  const directory = freshHome();
  const first = fixtureCapture(directory, "cfirst", "sqlite");
  const second = fixtureCapture(directory, "csecond", "postgres");
  first.exchanges[0]!.aborted = true;
  second.exchanges[0]!.aborted = true;
  writePrivate(join(directory, "captures", "cfirst.json"), JSON.stringify(first));
  writePrivate(join(directory, "captures", "csecond.json"), JSON.stringify(second));
  await assert.rejects(learn({ site: "reddit", op: "bad", examples: [{ query: "sqlite" }, { query: "postgres" }], from: "cfirst", from2: "csecond", requestId: 1 }),
    (error) => error instanceof EngineError && error.code === "REQUEST_REFUSED");
  first.exchanges[0]!.aborted = false;
  first.exchanges[0]!.request = { method: "POST", url: "https://www.reddit.com/api/submit", headers: {}, body: "title=sqlite" };
  second.exchanges[0]!.aborted = false;
  second.exchanges[0]!.request = { method: "POST", url: "https://www.reddit.com/api/submit", headers: {}, body: "title=postgres" };
  writePrivate(join(directory, "captures", "cfirst.json"), JSON.stringify(first));
  writePrivate(join(directory, "captures", "csecond.json"), JSON.stringify(second));
  await assert.rejects(learn({ site: "reddit", op: "bad", examples: [{ query: "sqlite" }, { query: "postgres" }], from: "cfirst", from2: "csecond", requestId: 1 }),
    (error) => error instanceof EngineError && error.code === "REQUEST_REFUSED");
  assert.deepEqual(listLearnedOperations("reddit"), []);
});

test("a user spec cannot enable writes by passing allowWrites or misdeclaring readOnly", async () => {
  freshHome();
  const spec = parseSite({ name: "reddit", baseUrl: "https://www.reddit.com", operations: [{
    name: "submit", readOnly: false, request: { method: "POST", url: "https://www.reddit.com/api/submit", body: "title=hello" },
    trigger: { url: "https://www.reddit.com/submit" },
  }] });
  saveSite(spec);
  let sent = 0;
  const fetchImpl: typeof fetch = async () => { sent++; return new Response("{}"); };
  await assert.rejects(callLearnedOperation("reddit", "submit", {}, { allowWrites: true, fetchImpl, maxTier: 1 }),
    (error) => error instanceof EngineError && error.code === "WRITE_REFUSED");
  spec.operations[0]!.readOnly = true;
  saveSite(spec);
  await assert.rejects(callLearnedOperation("reddit", "submit", {}, { allowWrites: true, fetchImpl, maxTier: 1 }),
    (error) => error instanceof EngineError && error.code === "WRITE_REFUSED");
  assert.equal(sent, 0);
});

test("an independent policy rejection prevents the actual HTTP implementation from running", async () => {
  const directory = freshHome();
  fixtureCapture(directory, "cfirst", "sqlite");
  fixtureCapture(directory, "csecond", "postgres");
  await learn({ site: "reddit", op: "search", examples: [{ query: "sqlite" }, { query: "postgres" }], from: "cfirst", from2: "csecond", requestId: 1, response: { extract: "data.children" } });
  setBrowserRequestPolicy(() => false);
  let sent = 0;
  const fetchImpl: typeof fetch = async () => { sent++; return new Response("{}"); };
  const result = await callLearnedOperation("reddit", "search", { query: "duckdb" }, { fetchImpl, maxTier: 1, minIntervalMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /read policy/);
  assert.equal(sent, 0);
});

test("manual sessions never refresh from a remembered personal browser profile", async () => {
  freshHome();
  saveSession("reddit", { cookies: [], values: {}, source: "chrome:Default" });
  assert.equal(await reimportIfBrowser("reddit", "https://www.reddit.com"), false);
  assert.equal(loadSession("reddit").source, "chrome:Default");
});

test("doctor reports the pinned engine and five upstream LinkedIn read recipes without importing cookies", () => {
  const directory = freshHome();
  const doctor = engineDoctor();
  assert.equal(doctor.commit, API_ANYTHING_COMMIT);
  assert.equal(doctor.home, directory);
  assert.equal(doctor.desktopSessionImport, false);
  assert.deepEqual(listLearnedOperations("linkedin").map((operation) => operation.name).sort(), ["getCompany", "getMe", "getProfile", "searchCompanies", "searchPeople"]);
  assert.equal(loadSession("linkedin").cookies.length, 0);
});

test("Product Hunt query captures learn nested JSON params and refuse GraphQL mutation captures", async () => {
  const directory = freshHome();
  const queryText = "query SearchPosts($query: String!) { search(query: $query) { name } }";
  for (const [id, value] of [["cfirst", "sqlite"], ["csecond", "postgres"]]) {
    const url = `https://www.producthunt.com/search?q=${value}`;
    writePrivate(join(directory, "captures", `${id}.json`), JSON.stringify({
      id, at: new Date().toISOString(), url, finalUrl: url, cookies: [], exchanges: [{
        id: 1, resourceType: "fetch", request: {
          method: "POST", url: "https://www.producthunt.com/frontend/graphql", headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationName: "SearchPosts", query: queryText, variables: { query: value } }),
        }, response: { status: 200, headers: {}, contentType: "application/json", body: JSON.stringify({ data: { search: [{ name: `${value} tool` }] } }) },
      }],
    }));
  }
  await learn({ site: "producthunt", op: "search", examples: [{ query: "sqlite" }, { query: "postgres" }], from: "cfirst", from2: "csecond", requestId: 1, response: { extract: "data.search", pick: ["name"] } });
  const operation = loadSite("producthunt")!.site.operations[0]!;
  assert.ok(operation.slots.some((slot) => slot.param === "query" && slot.at.includes("json:/variables/query")));
  let sent = 0;
  const result = await callLearnedOperation("producthunt", "search", { query: "duckdb" }, {
    maxTier: 1, minIntervalMs: 0,
    fetchImpl: async (_input, init) => {
      sent++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.variables.query, "duckdb");
      assert.equal(body.query, queryText);
      assert.equal(browserRequestAllowed({ url: "https://www.producthunt.com/frontend/graphql", method: "POST", postData: JSON.stringify({ query: "mutation Vote { vote(id: 1) }" }) }), false);
      assert.equal(browserRequestAllowed({ url: "https://www.producthunt.com/frontend/graphql", method: "POST", postData: JSON.stringify({ operationName: "PersistedUnknown", extensions: { persistedQuery: { sha256Hash: "abc" } } }) }), false);
      return new Response(JSON.stringify({ data: { search: [{ name: "DuckDB tool" }] } }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(sent, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [{ name: "DuckDB tool" }]);
  for (const id of ["cfirst", "csecond"]) {
    const path = join(directory, "captures", `${id}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.exchanges[0].request.body = JSON.stringify({ query: "mutation Vote { vote(id: 1) }" });
    writePrivate(path, JSON.stringify(record));
  }
  await assert.rejects(learn({ site: "producthunt", op: "vote", examples: [{ query: "sqlite" }, { query: "postgres" }], from: "cfirst", from2: "csecond", requestId: 1 }),
    (error) => error instanceof EngineError && error.code === "REQUEST_REFUSED");
  assert.deepEqual(listLearnedOperations("producthunt").map((item) => item.name), ["search"]);
});

test("LinkedIn seeded profile replay fills the CSRF cookie reference and redacts its transformed value", async () => {
  freshHome();
  const csrf = "ajax:fixture-csrf-432ab98fed";
  const cookie = (name: string, value: string) => ({ name, value, domain: ".linkedin.com", path: "/", expires: -1, httpOnly: true, secure: true });
  saveSession("linkedin", { cookies: [cookie("li_at", SECRET), cookie("JSESSIONID", `"${csrf}"`)], values: {}, source: "window" });
  let sent = 0;
  const result = await callLearnedOperation("linkedin", "getProfile", { publicId: "mockengineer" }, {
    maxTier: 1, minIntervalMs: 0,
    fetchImpl: async (input, init) => {
      sent++;
      const url = new URL(String(input));
      assert.equal(url.hostname, "www.linkedin.com");
      assert.equal(url.searchParams.get("memberIdentity"), "mockengineer");
      assert.equal(new Headers(init?.headers).get("csrf-token"), csrf);
      return new Response(JSON.stringify({ elements: [{ firstName: "Mock", lastName: "Engineer", headline: `A header echo ${csrf}`, publicIdentifier: "mockengineer" }] }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(sent, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { firstName: "Mock", lastName: "Engineer", headline: "A header echo [redacted]", publicIdentifier: "mockengineer" });
  assert.equal(JSON.stringify(result).includes(csrf), false);
});
