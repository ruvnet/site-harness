import { AdapterError } from './types.js';
import type { NativeOptions } from './types.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function requireEnvironment(options: NativeOptions, name: string, instruction: string): string {
  const value = (options.env ?? process.env)[name]?.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.length > 4096) {
    throw new AdapterError('AUTH_REQUIRED', instruction);
  }
  return value;
}

function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const number = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.ceil(number), 86400) : undefined;
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Already closed by the transport. */ }
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_RESPONSE_BYTES) {
    await discard(response);
    throw new AdapterError('UPSTREAM_ERROR', 'The upstream response exceeded the 4 MiB limit.', response.status);
  }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type && type !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(type)) {
    await discard(response);
    throw new AdapterError('UPSTREAM_ERROR', 'The upstream API returned a non-JSON response.', response.status);
  }
  if (!response.body) throw new AdapterError('UPSTREAM_ERROR', 'The upstream API returned an empty response.', response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AdapterError('UPSTREAM_ERROR', 'The upstream response exceeded the 4 MiB limit.', response.status);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('UPSTREAM_ERROR', 'The upstream API returned invalid JSON or an interrupted response.', response.status);
  } finally {
    reader.releaseLock();
  }
}

export async function requestJson(url: string, init: RequestInit, options: NativeOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new AdapterError('INPUT_INVALID', 'timeoutMs must be an integer from 1 through 120000.');
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, { ...init, redirect: 'error', signal });
  } catch {
    throw new AdapterError(signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR', signal.aborted ? 'The upstream API request timed out.' : 'Unable to reach the upstream API.');
  }
  if (!response.ok) {
    const wait = retryAfter(response.headers);
    await discard(response);
    if (response.status === 401 || response.status === 403) {
      throw new AdapterError('AUTH', 'The upstream API denied access. Check the token, required scopes, and application access.', response.status);
    }
    if (response.status === 429) throw new AdapterError('RATE_LIMIT', 'The upstream API rate limit was reached. Retry after the indicated delay.', response.status, wait);
    if (response.status === 404) throw new AdapterError('NOT_FOUND', 'The upstream resource was not found or is unavailable to this account.', response.status);
    throw new AdapterError('UPSTREAM_ERROR', `The upstream API returned HTTP ${response.status}.`, response.status);
  }
  try {
    return await boundedJson(response);
  } catch (error) {
    if (signal.aborted) throw new AdapterError('TIMEOUT', 'The upstream API response timed out.');
    throw error;
  }
}
