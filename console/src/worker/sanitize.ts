const credentialKey = /(?:^|[_-])(?:password|passwd|secret|token|authorization|api[_-]?key|cookie|session|csrf|xsrf|signature|credentials?|jwt)(?:$|[_-])|(?:Token|Secret|Password|Passwd|ApiKey|CookieValue|SessionId|Signature|Credential|AccessKeyId|Jwt)$|^(?:auth|authentication|csrfToken|xsrfToken|li_at|JSESSIONID|PHPSESSID|cf_clearance)$/i;
const credentialQuery = (key: string): boolean => credentialKey.test(key) || /^(?:key|code|authCode|accessKey|sig)$/i.test(key);
const rawKey = /^(?:headers|(?:request|response)[_-]?headers|cookies?|storage|storage[_-]?state|local[_-]?storage|session[_-]?storage|post[_-]?data|raw[_-]?captures?|raw[_-]?body|(?:request|response)[_-]?body|response[_-]?text|browser[_-]?context|env|environment)$/i;
const jwt = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const signedValue = /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi;
const labeledSecret = /\b(?:password|passwd|secret|token|access_token|refresh_token|client_secret|api[_-]?key|authorization|session|sessionid|cookie|csrftoken|xsrftoken)\s*[:=]\s*[^\s,;"']{4,}/gi;
const knownSecret = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43})\b/gi;
const schemaFields = new Set(['schema', 'inputSchema', 'schemas', 'properties', '$defs', 'definitions', 'items', 'additionalProperties', 'securitySchemes']);

export function sanitizedText(value: string, maximum = 20_000): string {
  let text = value.replace(jwt, '[redacted]').replace(signedValue, '[redacted]').replace(labeledSecret, '[redacted]').replace(knownSecret, '[redacted]');
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (credentialQuery(key)) url.searchParams.set(key, '[redacted]');
      if (/token|secret|password|session|auth/i.test(url.hash)) url.hash = '';
      text = url.toString();
    } catch { /* Non-URL text is still filtered above. */ }
  }
  return text.length > maximum ? text.slice(0, maximum) + '…' : text;
}

/** Retains inferred schema vocabulary but strips transport state and credential values. */
export function sanitizeData(value: unknown, depth = 0, schemaContext = false, sensitiveSchema = false): unknown {
  if (depth > 40) return '[depth limit]';
  if (typeof value === 'string') return sanitizedText(value, Number.MAX_SAFE_INTEGER);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(item => sanitizeData(item, depth + 1, schemaContext, sensitiveSchema));
  if (!value || typeof value !== 'object') return null;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const isSchema = schemaContext || schemaFields.has(key);
    const sensitive = credentialKey.test(key);
    if (rawKey.test(key) && !isSchema && typeof child !== 'boolean') continue;
    if (/^(?:requests|exchanges|sessions)$/i.test(key) && Array.isArray(child) && !schemaContext) continue;
    if (sensitiveSchema && ['example', 'examples', 'default', 'const', 'enum'].includes(key)) continue;
    if (sensitive && (typeof child === 'string' || typeof child === 'number')) { output[key] = '[redacted]'; continue; }
    output[key] = sanitizeData(child, depth + 1, isSchema, sensitiveSchema || (sensitive && isSchema));
  }
  return output;
}

/** Job arguments must never be a way to transfer browser or API credentials. */
export function hasCredentials(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username || url.password || [...url.searchParams.keys()].some(credentialQuery)) return true;
        return sanitizedText(value, Number.MAX_SAFE_INTEGER) !== url.toString();
      } catch { return true; }
    }
    return sanitizedText(value, Number.MAX_SAFE_INTEGER) !== value;
  }
  if (Array.isArray(value)) return value.some(child => hasCredentials(child, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (rawKey.test(key) && child !== null) || (credentialKey.test(key) && child !== null && typeof child !== 'boolean') || hasCredentials(child, depth + 1));
}
