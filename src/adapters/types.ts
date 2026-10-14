export type NativeSite = 'producthunt' | 'reddit';

export interface NativeOperation {
  site: NativeSite;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: true;
  transport: 'official-api';
  requirements: readonly string[];
  source: string;
}

export interface NativeOptions {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type AdapterErrorCode =
  | 'INPUT_INVALID'
  | 'UNKNOWN_OPERATION'
  | 'AUTH_REQUIRED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR';

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly status?: number;
  readonly retryAfter?: number;

  constructor(code: AdapterErrorCode, message: string, status?: number, retryAfter?: number) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
