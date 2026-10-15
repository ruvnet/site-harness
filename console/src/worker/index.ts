import { z } from 'zod';
import { ASSETS } from '../assets.generated.js';
import { ownerIdentity, hashSecret, sameHash, createSecret, verifyAccessIdentity, sessionSecret, sessionCookie, SESSION_MS } from './auth.js';
import { defaultSettings, settingsSchema, newJobSchema, pairingSchema, pollSchema, jobResultSchema, remixInputSchema, safeSnapshot, safeResult, validateArgs, ValidationError, MAX_RESULT, MAX_SNAPSHOT } from './validation.js';
import { hasCredentials, sanitizedText } from './sanitize.js';
import type { Env, AgentRow, JobRow, RemixRow, D1PreparedStatement } from './types.js';

export { verifyAccessIdentity };
export { sanitizeData, hasCredentials } from './sanitize.js';
export { safeResult, safeSnapshot, validateArgs } from './validation.js';

const LEASE_MS = 120_000;
const ONLINE_MS = 45_000;
const MAX_AGENTS = 100;
const JOB_LIMIT = 40;

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function headers(contentType = 'application/json; charset=utf-8'): Headers {
  return new Headers({
    'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://*.cloudflareaccess.com",
  });
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: headers() }); }
function redirect(location: string): Response { const responseHeaders = headers(); responseHeaders.set('Location', location); return new Response(null, { status: 302, headers: responseHeaders }); }
function sameOrigin(request: Request): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new HttpError(403, 'A same-origin request is required.');
}
function uuid(value: string): string { if (!z.string().uuid().safeParse(value).success) throw new HttpError(400, 'Invalid identifier.'); return value; }

async function readJson(request: Request, maximum: number): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Use application/json.');
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new HttpError(413, 'Request exceeds its size budget.');
  if (!request.body) throw new HttpError(400, 'A JSON body is required.');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maximum);
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (total + part.value.byteLength > maximum) {
      try { await reader.cancel(); } catch { /* The size rejection still applies if the peer already closed. */ }
      throw new HttpError(413, 'Request exceeds its size budget.');
    }
    bytes.set(part.value, total);
    total += part.value.byteLength;
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))); }
  catch { throw new HttpError(400, 'Invalid JSON body.'); }
}

async function settings(env: Env): Promise<typeof defaultSettings> {
  const row = await env.DB.prepare('SELECT settings_json FROM settings WHERE id = 1').first<{ settings_json: string }>();
  return row ? settingsSchema.parse(JSON.parse(row.settings_json)) : { ...defaultSettings };
}

async function authRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
  sameOrigin(request);
  if (url.pathname === '/auth/logout') {
    const session = sessionSecret(request);
    if (session) await env.DB.prepare('DELETE FROM console_sessions WHERE token_hash = ?').bind(await hashSecret(session)).run();
    const response = json({ ok: true });
    response.headers.set('Set-Cookie', sessionCookie('', 0));
    return response;
  }
  if (url.pathname !== '/auth/login') throw new HttpError(404, 'Sign-in route not found.');
  if (!env.CONSOLE_CODE_HASH || !/^[a-f0-9]{64}$/.test(env.CONSOLE_CODE_HASH) || !env.OWNER_EMAIL) throw new HttpError(503, 'Workspace sign-in is not configured.');
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const limiterKey = await hashSecret(`console-login:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
  const attempt = await env.DB.prepare('INSERT INTO console_login_attempts (limiter_key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(limiter_key) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING attempts, expires_at')
    .bind(limiterKey, now + windowMs, now, now).first<{ attempts: number; expires_at: number }>();
  if (!attempt || attempt.attempts > 8) {
    const response = json({ ok: false, error: 'Too many attempts. Please try again in a few minutes.' }, 429);
    response.headers.set('Retry-After', String(Math.max(1, Math.ceil(((attempt?.expires_at ?? now + windowMs) - now) / 1000))));
    return response;
  }
  const input = z.object({ code: z.string().min(1).max(256) }).strict().parse(await readJson(request, 4096));
  if (!sameHash(await hashSecret(input.code), env.CONSOLE_CODE_HASH)) throw new HttpError(401, 'That access code is incorrect. Please try again.');
  const session = createSecret();
  const previous = sessionSecret(request);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM console_sessions WHERE expires_at <= ? OR token_hash = ?').bind(now, previous ? await hashSecret(previous) : ''),
    env.DB.prepare('DELETE FROM console_login_attempts WHERE limiter_key = ? OR expires_at <= ?').bind(limiterKey, now),
    env.DB.prepare('INSERT INTO console_sessions (token_hash, code_hash, expires_at) VALUES (?, ?, ?)').bind(await hashSecret(session), env.CONSOLE_CODE_HASH, now + SESSION_MS),
  ]);
  const response = json({ ok: true, user: { email: env.OWNER_EMAIL } });
  response.headers.set('Set-Cookie', sessionCookie(session));
  return response;
}

function jobView(row: JobRow & { result_available?: number }): Record<string, unknown> {
  return {
    id: row.id, agentId: row.agent_id, action: row.action, args: JSON.parse(row.args_json), status: row.status,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
    result: row.result_json ? JSON.parse(row.result_json) : null, error: row.error,
    ...(row.result_available && !row.result_json ? { resultAvailable: true } : {}),
  };
}

function remixView(row: RemixRow): Record<string, unknown> {
  return { id: row.id, name: row.name, description: row.description, definition: JSON.parse(row.definition_json), createdAt: row.created_at, updatedAt: row.updated_at };
}

function expireJobs(env: Env, now: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE jobs SET status = 'failed', finished_at = ?, lease_until = NULL, error = 'Agent lease expired; check the desktop before retrying.' WHERE status = 'running' AND lease_until <= ?").bind(now, now);
}

async function agentIdentity(request: Request, env: Env): Promise<AgentRow> {
  const token = request.headers.get('Authorization');
  const match = token?.match(/^Bearer ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i);
  if (!match) throw new HttpError(401, 'Valid desktop pairing is required.');
  const row = await env.DB.prepare('SELECT * FROM agents WHERE id = ? AND enabled = 1').bind(match[1].toLowerCase()).first<AgentRow>();
  if (!row || !sameHash(await hashSecret(match[2]), row.token_hash)) throw new HttpError(401, 'Valid desktop pairing is required.');
  return row;
}

function saveSnapshot(env: Env, agent: AgentRow, snapshot: Record<string, unknown>, now: string): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO snapshots (agent_id, payload_json, at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM agents WHERE id = ? AND enabled = 1 AND token_hash = ?) ON CONFLICT(agent_id) DO UPDATE SET payload_json = excluded.payload_json, at = excluded.at')
    .bind(agent.id, JSON.stringify(snapshot), now, agent.id, agent.token_hash);
}

async function state(env: Env, email: string, agentId?: string): Promise<Response> {
  if (agentId && !await env.DB.prepare('SELECT id FROM agents WHERE id = ? AND enabled = 1').bind(agentId).first<{ id: string }>()) throw new HttpError(404, 'Enabled desktop not found.');
  const now = new Date().toISOString();
  await expireJobs(env, now).run();
  const [configuration, agents, snapshot, jobs, remixes] = await Promise.all([
    settings(env),
    env.DB.prepare('SELECT id, name, version, last_seen_at, enabled FROM agents ORDER BY created_at DESC LIMIT ?').bind(MAX_AGENTS).all<AgentRow>(),
    env.DB.prepare('SELECT s.payload_json FROM snapshots s JOIN agents a ON a.id = s.agent_id WHERE a.enabled = 1 AND (? IS NULL OR a.id = ?) ORDER BY s.at DESC LIMIT 1').bind(agentId ?? null, agentId ?? null).first<{ payload_json: string }>(),
    env.DB.prepare('SELECT id, agent_id, action, args_json, status, created_at, started_at, finished_at, lease_until, CASE WHEN id IN (SELECT id FROM jobs WHERE result_json IS NOT NULL AND (? IS NULL OR agent_id = ?) ORDER BY created_at DESC, id DESC LIMIT 2) THEN result_json ELSE NULL END AS result_json, result_json IS NOT NULL AS result_available, error FROM jobs WHERE (? IS NULL OR agent_id = ?) ORDER BY created_at DESC, id DESC LIMIT ?').bind(agentId ?? null, agentId ?? null, agentId ?? null, agentId ?? null, JOB_LIMIT).all<JobRow & { result_available: number }>(),
    env.DB.prepare('SELECT * FROM remix_projects ORDER BY updated_at DESC LIMIT 100').all<RemixRow>(),
  ]);
  return json({ ok: true, user: { email }, settings: configuration,
    agents: agents.results.map(agent => ({ id: agent.id, name: agent.name, version: agent.version, lastSeenAt: agent.last_seen_at,
      status: agent.enabled && agent.last_seen_at && Date.now() - Date.parse(agent.last_seen_at) < ONLINE_MS ? 'online' : 'offline', enabled: !!agent.enabled })),
    snapshot: snapshot ? JSON.parse(snapshot.payload_json) : null, jobs: jobs.results.map(jobView), remixes: remixes.results.map(remixView),
  });
}

async function api(request: Request, env: Env, url: URL, email: string): Promise<Response> {
  const method = request.method;
  if (!['GET', 'HEAD'].includes(method)) sameOrigin(request);
  if (url.pathname === '/api/state' && method === 'GET') {
    if ([...url.searchParams.keys()].some(key => key !== 'agentId') || url.searchParams.getAll('agentId').length > 1) throw new HttpError(400, 'Use one optional desktop identifier.');
    const agentId = url.searchParams.has('agentId') ? uuid(url.searchParams.get('agentId')!).toLowerCase() : undefined;
    return state(env, email, agentId);
  }
  if (url.pathname === '/api/login' && method === 'GET') return redirect('/');
  if (url.pathname === '/api/logout' && method === 'GET') return redirect(new URL('/cdn-cgi/access/logout', env.ACCESS_TEAM_DOMAIN).toString());
  if (url.pathname === '/api/settings' && method === 'PUT') {
    const configuration = settingsSchema.parse(await readJson(request, 4096));
    await env.DB.prepare('INSERT INTO settings (id, settings_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at').bind(JSON.stringify(configuration), new Date().toISOString()).run();
    return json({ ok: true, settings: configuration });
  }
  if (url.pathname === '/api/remixes') {
    if (method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM remix_projects ORDER BY updated_at DESC LIMIT 100').all<RemixRow>();
      return json({ ok: true, remixes: rows.results.map(remixView) });
    }
    if (method === 'POST') {
      const input = remixInputSchema.parse(await readJson(request, 131_072));
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const row = await env.DB.prepare('INSERT INTO remix_projects (id, name, description, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
        .bind(id, sanitizedText(input.name, 100), sanitizedText(input.description, 500), JSON.stringify(input.definition), now, now).first<RemixRow>();
      if (!row) throw new HttpError(500, 'The remix project could not be created.');
      return json({ ok: true, remix: remixView(row) }, 201);
    }
  }
  const remixMatch = url.pathname.match(/^\/api\/remixes\/([^/]+)$/);
  if (remixMatch) {
    const id = uuid(remixMatch[1]);
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM remix_projects WHERE id = ?').bind(id).first<RemixRow>();
      if (!row) throw new HttpError(404, 'Remix project not found.');
      return json({ ok: true, remix: remixView(row) });
    }
    if (method === 'PUT') {
      const input = remixInputSchema.parse(await readJson(request, 131_072));
      const row = await env.DB.prepare('UPDATE remix_projects SET name = ?, description = ?, definition_json = ?, updated_at = ? WHERE id = ? RETURNING *')
        .bind(sanitizedText(input.name, 100), sanitizedText(input.description, 500), JSON.stringify(input.definition), new Date().toISOString(), id).first<RemixRow>();
      if (!row) throw new HttpError(404, 'Remix project not found.');
      return json({ ok: true, remix: remixView(row) });
    }
    if (method === 'DELETE') {
      const row = await env.DB.prepare('DELETE FROM remix_projects WHERE id = ? RETURNING id').bind(id).first<{ id: string }>();
      if (!row) throw new HttpError(404, 'Remix project not found.');
      return json({ ok: true });
    }
  }
  if (url.pathname === '/api/agents' && method === 'POST') {
    const input = pairingSchema.parse(await readJson(request, 4096));
    if (hasCredentials(input)) throw new ValidationError('Use a desktop name without credentials.');
    const id = crypto.randomUUID(); const secret = createSecret();
    const row = await env.DB.prepare('INSERT INTO agents (id, name, token_hash, created_at) SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM agents) < ? RETURNING id, name').bind(id, sanitizedText(input.name, 100), await hashSecret(secret), new Date().toISOString(), MAX_AGENTS).first<{ id: string; name: string }>();
    if (!row) throw new HttpError(409, 'The desktop pairing limit has been reached.');
    return json({ ok: true, agent: row, token: `${id}.${secret}` }, 201);
  }
  if (url.pathname === '/api/jobs' && method === 'POST') {
    const input = newJobSchema.parse(await readJson(request, 67_000));
    const args = validateArgs(input.action, input.args);
    const row = await env.DB.prepare("INSERT INTO jobs (id, agent_id, action, args_json, status, created_at) SELECT ?, ?, ?, ?, 'queued', ? WHERE EXISTS (SELECT 1 FROM agents WHERE id = ? AND enabled = 1) AND (SELECT count(*) FROM jobs WHERE agent_id = ? AND status IN ('queued', 'running')) < 100 RETURNING *")
      .bind(crypto.randomUUID(), input.agentId, input.action, JSON.stringify(args), new Date().toISOString(), input.agentId, input.agentId).first<JobRow>();
    if (!row) throw new HttpError(409, 'Pair an enabled desktop or clear its queue before adding jobs.');
    return json({ ok: true, job: jobView(row) }, 201);
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(cancel))?$/);
  if (jobMatch) {
    const id = uuid(jobMatch[1]);
    if (method === 'GET' && !jobMatch[2]) {
      const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
      if (!row) throw new HttpError(404, 'Job not found.');
      return json({ ok: true, job: jobView(row) });
    }
    if (method === 'POST' && jobMatch[2] === 'cancel') {
      const row = await env.DB.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, error = 'Cancelled before dispatch.' WHERE id = ? AND status = 'queued' RETURNING *").bind(new Date().toISOString(), id).first<JobRow>();
      if (!row) throw new HttpError(409, 'Only a queued job can be cancelled.');
      return json({ ok: true, job: jobView(row) });
    }
  }
  const revokeMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/revoke$/);
  if (revokeMatch && method === 'POST') {
    const id = uuid(revokeMatch[1]); const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE agents SET enabled = 0, token_hash = '' WHERE id = ? RETURNING id").bind(id),
      env.DB.prepare("UPDATE jobs SET status = 'failed', finished_at = ?, lease_until = NULL, error = 'Agent pairing was revoked before dispatch.' WHERE agent_id = ? AND status = 'queued'").bind(now, id),
      env.DB.prepare("UPDATE jobs SET status = 'failed', finished_at = ?, lease_until = NULL, error = 'Agent pairing was revoked; the local operation may still be running.' WHERE agent_id = ? AND status = 'running'").bind(now, id),
    ]);
    if (!results[0].results.length) throw new HttpError(404, 'Desktop not found.');
    return json({ ok: true });
  }
  throw new HttpError(404, 'API route not found.');
}

async function agentRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  const agent = await agentIdentity(request, env);
  if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  if (url.pathname === '/agent/poll') {
    const input = pollSchema.parse(await readJson(request, MAX_SNAPSHOT + 4096));
    const snapshot = input.snapshot ? safeSnapshot(input.snapshot) : undefined;
    const statements = [
      expireJobs(env, now),
      env.DB.prepare('UPDATE agents SET version = ?, last_seen_at = ? WHERE id = ? AND enabled = 1 AND token_hash = ? RETURNING id').bind(sanitizedText(input.version, 100), now, agent.id, agent.token_hash),
      env.DB.prepare("UPDATE jobs SET lease_until = ? WHERE agent_id = ? AND status = 'running' AND lease_until > ? AND id = ? AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND enabled = 1 AND token_hash = ?)").bind(lease, agent.id, now, input.activeJobId ?? null, agent.id, agent.token_hash),
    ];
    if (snapshot) statements.push(saveSnapshot(env, agent, snapshot, now));
    statements.push(env.DB.prepare("UPDATE jobs SET status = 'running', started_at = ?, lease_until = ? WHERE ? IS NULL AND id = (SELECT id FROM jobs WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM jobs WHERE agent_id = ? AND status = 'running') AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND enabled = 1 AND token_hash = ?) RETURNING *").bind(now, lease, input.activeJobId ?? null, agent.id, agent.id, agent.id, agent.token_hash));
    const results = await env.DB.batch(statements);
    if (!results[1].results.length) throw new HttpError(401, 'Desktop pairing has been revoked.');
    const jobs = results[results.length - 1].results as unknown as JobRow[];
    return json({ ok: true, settings: await settings(env), job: jobs[0] ? jobView(jobs[0]) : null });
  }
  const resultMatch = url.pathname.match(/^\/agent\/jobs\/([^/]+)\/result$/);
  if (resultMatch) {
    const id = uuid(resultMatch[1]);
    const input = jobResultSchema.parse(await readJson(request, MAX_RESULT + MAX_SNAPSHOT + 4096));
    const result = safeResult(input.result);
    const snapshot = input.snapshot ? safeSnapshot(input.snapshot) : undefined;
    const row = await env.DB.prepare("UPDATE jobs SET status = ?, finished_at = ?, lease_until = NULL, result_json = ?, error = ? WHERE id = ? AND agent_id = ? AND status = 'running' AND lease_until > ? AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND enabled = 1 AND token_hash = ?) RETURNING id")
      .bind(result.ok ? 'succeeded' : 'failed', now, JSON.stringify(result), result.ok ? null : sanitizedText(String(result.reason), 2000), id, agent.id, now, agent.id, agent.token_hash).first<{ id: string }>();
    if (!row) throw new HttpError(409, 'The job is not owned by this desktop with an active lease.');
    if (snapshot) await saveSnapshot(env, agent, snapshot, now).run();
    await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ? AND enabled = 1 AND token_hash = ?').bind(now, agent.id, agent.token_hash).run();
    return json({ ok: true });
  }
  throw new HttpError(404, 'Desktop route not found.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, service: 'site-harness-console' });
      if (url.pathname.startsWith('/auth/')) return await authRoutes(request, env, url);
      if (url.pathname.startsWith('/api/')) {
        let user: { email: string };
        try { user = await ownerIdentity(request, env); }
        catch {
          if (url.pathname === '/api/login' && request.method === 'GET') return redirect('/signup');
          throw new HttpError(401, 'Sign in with your workspace access code.');
        }
        return await api(request, env, url, user.email);
      }
      if (url.pathname.startsWith('/agent/')) return await agentRoutes(request, env, url);
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Use GET.');
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const assets = ASSETS as Record<string, { body: string; contentType: string }>;
      const asset = assets[path] ?? (['/overview', '/network', '/targets', '/operations', '/settings', '/signup', '/signin'].includes(path) ? assets['/index.html'] : undefined);
      if (!asset) throw new HttpError(404, 'Page not found.');
      return new Response(request.method === 'HEAD' ? null : asset.body, { headers: headers(asset.contentType) });
    } catch (error) {
      if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status);
      if (error instanceof ValidationError) return json({ ok: false, error: error.message }, 400);
      if (error instanceof z.ZodError) return json({ ok: false, error: 'Invalid request arguments.' }, 400);
      return json({ ok: false, error: 'The management service could not complete this request.' }, 500);
    }
  },
};
