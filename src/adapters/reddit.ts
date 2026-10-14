import { requestJson, requireEnvironment } from './http.js';
import { AdapterError } from './types.js';
import type { NativeOptions } from './types.js';
import { isRecord } from './validation.js';

const ORIGIN = 'https://oauth.reddit.com';

function listing(body: unknown): Record<string, unknown> & { children: unknown[] } {
  if (!isRecord(body) || body.kind !== 'Listing' || !isRecord(body.data) || !Array.isArray(body.data.children)) {
    throw new AdapterError('UPSTREAM_ERROR', 'Reddit returned an unexpected listing response.');
  }
  return body.data as Record<string, unknown> & { children: unknown[] };
}

function firstPost(value: Record<string, unknown> & { children: unknown[] }): Record<string, unknown> {
  const first = value.children[0];
  if (first === undefined) throw new AdapterError('NOT_FOUND', 'The Reddit post was not found or is unavailable to this account.', 404);
  if (!isRecord(first) || first.kind !== 't3' || !isRecord(first.data)) throw new AdapterError('UPSTREAM_ERROR', 'Reddit returned an unexpected post response.');
  return first.data;
}

export async function executeReddit(name: string, args: Record<string, unknown>, options: NativeOptions): Promise<unknown> {
  const token = requireEnvironment(options, 'REDDIT_ACCESS_TOKEN', 'Set REDDIT_ACCESS_TOKEN to a registered Reddit OAuth token with read scope.');
  const userAgent = requireEnvironment(options, 'REDDIT_USER_AGENT', 'Set REDDIT_USER_AGENT to platform:app:version (by /u/your_username).');
  const id = typeof args.postId === 'string' ? args.postId.replace(/^t3_/, '') : undefined;
  const paths: Record<string, string> = {
    search: args.subreddit ? `/r/${args.subreddit}/search` : '/search',
    posts: `/r/${args.subreddit}/${args.sort}`,
    post: `/by_id/t3_${id}`,
    comments: `/comments/${id}`,
    subreddit: `/r/${args.subreddit}/about`,
  };
  const url = new URL(paths[name]!, ORIGIN);
  url.searchParams.set('raw_json', '1');
  if (name === 'search') {
    url.searchParams.set('q', args.query as string);
    url.searchParams.set('type', 'link');
    url.searchParams.set('sort', args.sort as string);
    url.searchParams.set('t', args.time as string);
    if (args.subreddit) url.searchParams.set('restrict_sr', 'true');
  }
  if (name === 'posts' && (args.sort === 'top' || args.sort === 'controversial')) url.searchParams.set('t', args.time as string);
  if (name === 'search' || name === 'posts' || name === 'comments') {
    url.searchParams.set('limit', String(args.limit));
    if (args.after) url.searchParams.set('after', args.after as string);
  }
  if (name === 'comments') {
    url.searchParams.set('sort', args.sort as string);
    if (args.depth !== undefined) url.searchParams.set('depth', String(args.depth));
  }
  const body = await requestJson(url.href, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': userAgent } }, options);
  if (name === 'search' || name === 'posts') return listing(body);
  if (name === 'post') return firstPost(listing(body));
  if (name === 'comments') {
    if (!Array.isArray(body) || body.length !== 2) throw new AdapterError('UPSTREAM_ERROR', 'Reddit returned an unexpected comment tree response.');
    return { post: firstPost(listing(body[0])), comments: listing(body[1]).children };
  }
  if (!isRecord(body) || body.kind !== 't5' || !isRecord(body.data)) throw new AdapterError('UPSTREAM_ERROR', 'Reddit returned unexpected subreddit metadata.');
  return body.data;
}
