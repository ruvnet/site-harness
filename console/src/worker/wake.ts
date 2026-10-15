import type { Env } from './types';

/** Destination and credential are deployment configuration, never caller supplied. */
export async function wakeAgent(env: Env, agentId: string): Promise<{ state: string; message: string }> {
  const agent = await env.DB.prepare('SELECT last_seen_at FROM agents WHERE id = ? AND enabled = 1').bind(agentId).first<{last_seen_at: string | null}>();
  if (!agent) return { state: 'unavailable', message: 'Enabled desktop not found.' };
  if (agent.last_seen_at && Date.now() - Date.parse(agent.last_seen_at) < 45_000) return { state: 'online', message: 'Desktop is connected.' };
  if (!env.WAKE_URL || !env.WAKE_TOKEN || env.WAKE_AGENT_ID !== agentId) return { state: 'unconfigured', message: 'Automatic wake is not configured for this desktop. Open ruOS to start it; queued work is preserved.' };
  const url = new URL(env.WAKE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return { state: 'failed', message: 'Wake endpoint configuration is invalid.' };
  const now = Date.now();
  const claimed = await env.DB.prepare('INSERT INTO agent_wakes (agent_id, attempted_at) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET attempted_at = excluded.attempted_at WHERE attempted_at < ? RETURNING agent_id').bind(agentId, now, now - 60_000).first();
  if (!claimed) return { state: 'pending', message: 'A wake request was recently attempted. Waiting for a desktop heartbeat.' };
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${env.WAKE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }), signal: AbortSignal.timeout(8000) });
    return response.ok ? { state: 'requested', message: 'Wake accepted. Waiting for the desktop heartbeat.' } : { state: 'failed', message: 'Wake service rejected the request. Queued work is preserved; open ruOS to start the desktop.' };
  } catch { return { state: 'failed', message: 'Wake service could not be reached. Queued work is preserved; open ruOS to start the desktop.' }; }
}
