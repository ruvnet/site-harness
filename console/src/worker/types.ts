export interface D1Result<T = Record<string, unknown>> { success: boolean; results: T[]; meta?: { changes?: number }; }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
export interface Env { DB: D1Database; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; OWNER_EMAIL: string; CONSOLE_CODE_HASH?: string; WAKE_URL?: string; WAKE_TOKEN?: string; WAKE_AGENT_ID?: string; }
export interface AgentRow { id: string; name: string; token_hash: string; enabled: number; version: string; last_seen_at: string | null; created_at: string; }
export interface JobRow { id: string; agent_id: string; action: string; args_json: string; status: string; created_at: string; started_at: string | null; finished_at: string | null; lease_until: string | null; result_json: string | null; error: string | null; }
export interface RemixRow { id: string; name: string; description: string; definition_json: string; created_at: string; updated_at: string; }
