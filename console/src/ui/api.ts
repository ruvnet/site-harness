import { isObject, type Json } from './types';

export class ApiError extends Error {
  constructor(message: string, readonly signedOut = false, readonly status = 0) { super(message); }
}
export async function request<T>(path: string, options: { method?: string; body?: Json; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    method: options.method ?? 'GET',
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal,
  });
  const contentType = response.headers.get('content-type') ?? '';
  if ([401, 403].includes(response.status) || !contentType.includes('application/json')) {
    throw new ApiError('Sign in with your authorized owner account to open the console.', true, response.status);
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new ApiError('The console returned an unreadable response.'); }
  if (!response.ok || !isObject(value) || value.ok !== true) {
    throw new ApiError(isObject(value) && typeof value.error === 'string' ? value.error : `Request failed (${response.status}).`, false, response.status);
  }
  return value as T;
}
