import { requestJson, requireEnvironment } from './http.js';
import { AdapterError } from './types.js';
import type { NativeOptions } from './types.js';
import { isRecord } from './validation.js';

const ENDPOINT = 'https://api.producthunt.com/v2/api/graphql';
const POST_FIELDS = 'id name slug tagline description website url votesCount commentsCount createdAt featuredAt';
const PAGE_FIELDS = 'pageInfo { endCursor hasNextPage startCursor hasPreviousPage } totalCount';
const QUERIES: Record<string, string> = {
  posts: `query SiteHarnessPosts($first: Int!, $after: String, $order: PostsOrder, $featured: Boolean, $topic: String, $postedAfter: DateTime, $postedBefore: DateTime) {
    posts(first: $first, after: $after, order: $order, featured: $featured, topic: $topic, postedAfter: $postedAfter, postedBefore: $postedBefore) {
      nodes { ${POST_FIELDS} } ${PAGE_FIELDS}
    }
  }`,
  post: `query SiteHarnessPost($id: ID, $slug: String) { post(id: $id, slug: $slug) { ${POST_FIELDS} } }`,
  comments: `query SiteHarnessComments($id: ID, $slug: String, $first: Int!, $after: String) {
    post(id: $id, slug: $slug) { comments(first: $first, after: $after) {
      nodes { id body createdAt url parentId votesCount } ${PAGE_FIELDS}
    } }
  }`,
  topics: `query SiteHarnessTopics($query: String, $first: Int!, $after: String) {
    topics(query: $query, first: $first, after: $after) { nodes { id name slug } ${PAGE_FIELDS} }
  }`,
};

export async function executeProductHunt(name: string, args: Record<string, unknown>, options: NativeOptions): Promise<unknown> {
  const token = requireEnvironment(options, 'PRODUCTHUNT_TOKEN', 'Set PRODUCTHUNT_TOKEN to a Product Hunt access or developer token with public scope.');
  const body = await requestJson(ENDPOINT, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: QUERIES[name], variables: args }),
  }, options);
  if (!isRecord(body)) throw new AdapterError('UPSTREAM_ERROR', 'Product Hunt returned an unexpected GraphQL response.');
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const codes = body.errors.flatMap((error: unknown) => isRecord(error) && isRecord(error.extensions) && typeof error.extensions.code === 'string' ? [error.extensions.code.toUpperCase()] : []);
    if (codes.some((code: string) => ['UNAUTHENTICATED', 'UNAUTHORIZED', 'FORBIDDEN'].includes(code))) {
      throw new AdapterError('AUTH', 'Product Hunt rejected the token or its scopes.');
    }
    if (codes.some((code: string) => ['RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'THROTTLED'].includes(code))) {
      throw new AdapterError('RATE_LIMIT', 'Product Hunt rejected the query because of an API limit.');
    }
    throw new AdapterError('UPSTREAM_ERROR', 'Product Hunt returned GraphQL errors. Check the operation and API access.');
  }
  if (!isRecord(body.data)) throw new AdapterError('UPSTREAM_ERROR', 'Product Hunt returned GraphQL data in an unexpected shape.');
  if (name === 'comments') {
    if (body.data.post === null) throw new AdapterError('NOT_FOUND', 'The Product Hunt post was not found.', 404);
    if (!isRecord(body.data.post) || !isRecord(body.data.post.comments)) throw new AdapterError('UPSTREAM_ERROR', 'Product Hunt returned a comment connection in an unexpected shape.');
    return connection(body.data.post.comments);
  }
  const value = body.data[name];
  if (name === 'post' && value === null) throw new AdapterError('NOT_FOUND', 'The Product Hunt post was not found.', 404);
  if (!isRecord(value)) throw new AdapterError('UPSTREAM_ERROR', 'Product Hunt returned operation data in an unexpected shape.');
  return name === 'post' ? value : connection(value);
}

function connection(value: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(value.nodes) || !isRecord(value.pageInfo)) throw new AdapterError('UPSTREAM_ERROR', 'Product Hunt returned pagination data in an unexpected shape.');
  return value;
}
