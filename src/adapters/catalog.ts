import type { NativeOperation } from './types.js';

type Field = Record<string, unknown>;
const text = (description: string, maxLength = 512): Field => ({ type: 'string', minLength: 1, maxLength, description });
const limit = (name: string, maximum = 100, value = 25): Field => ({ type: 'integer', minimum: 1, maximum, default: value, description: `Maximum ${name} to return in this request.` });
const choice = (values: readonly string[], value: string, description: string): Field => ({ type: 'string', enum: values, default: value, description });
const schema = (properties: Record<string, Field>, required: string[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false, ...extra });

const phRequirements = ['PRODUCTHUNT_TOKEN: access or developer token with public scope'];
const redditRequirements = [
  'REDDIT_ACCESS_TOKEN: registered OAuth token with read scope',
  'REDDIT_USER_AGENT: platform:app:version (by /u/your_username)',
];
const cursor = text('Opaque cursor returned by the previous page.', 1024);
const slug = { ...text('Product Hunt URL slug.', 200), pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' };
const phId = { ...text('Product Hunt post ID.', 128), pattern: '^[A-Za-z0-9_-]+$' };
const postSelector = { id: phId, slug };
const exactlyOneSelector = { oneOf: [{ required: ['id'] }, { required: ['slug'] }] };
const subreddit = { ...text('Subreddit name without the r/ prefix.', 21), pattern: '^[A-Za-z0-9_]+$' };
const postId = { ...text('Reddit base36 post ID, optionally prefixed with t3_.', 32), pattern: '^(?:t3_)?[a-z0-9]+$' };
const after = { ...text('Post fullname returned as the previous listing\'s after cursor.', 40), pattern: '^t3_[a-z0-9]+$' };
const time = choice(['hour', 'day', 'week', 'month', 'year', 'all'], 'all', 'Time window for search, top, or controversial listings.');
const listingFields = { limit: limit('posts'), after };
const timestamp = { ...text('ISO 8601 timestamp including a timezone.', 64), format: 'date-time' };

export const nativeOperations: readonly NativeOperation[] = [
  {
    site: 'producthunt', name: 'posts', readOnly: true, transport: 'official-api', requirements: phRequirements,
    source: 'https://api-v2-docs.producthunt.com/query/posts/',
    description: 'List Product Hunt launch posts with filters and cursor pagination. The upstream defaults postedAfter to one month ago. This is not full-text product search.',
    inputSchema: schema({
      first: limit('launch posts', 50, 20), after: cursor,
      order: choice(['FEATURED_AT', 'NEWEST', 'RANKING', 'VOTES'], 'NEWEST', 'Ordering for launch posts.'),
      featured: { type: 'boolean', description: 'Filter posts by whether they were featured.' },
      topic: { ...slug, description: 'Filter by a Product Hunt topic slug.' },
      postedAfter: timestamp, postedBefore: timestamp,
    }),
  },
  {
    site: 'producthunt', name: 'post', readOnly: true, transport: 'official-api', requirements: phRequirements,
    source: 'https://api-v2-docs.producthunt.com/query/post/',
    description: 'Read a Product Hunt launch post by exactly one of id or slug.',
    inputSchema: schema(postSelector, [], exactlyOneSelector),
  },
  {
    site: 'producthunt', name: 'comments', readOnly: true, transport: 'official-api', requirements: phRequirements,
    source: 'https://api-v2-docs.producthunt.com/object/post/',
    description: 'Read one page of comments on a Product Hunt launch post, identified by exactly one of id or slug. Replies are not expanded.',
    inputSchema: schema({ ...postSelector, first: limit('comments', 50, 20), after: cursor }, [], exactlyOneSelector),
  },
  {
    site: 'producthunt', name: 'topics', readOnly: true, transport: 'official-api', requirements: phRequirements,
    source: 'https://api-v2-docs.producthunt.com/query/topics/',
    description: 'List or search Product Hunt topics by name or alias, with cursor pagination. This searches topics, not products.',
    inputSchema: schema({ query: text('Topic name or alias to match.', 200), first: limit('topics', 50, 20), after: cursor }),
  },
  {
    site: 'reddit', name: 'search', readOnly: true, transport: 'official-api', requirements: redditRequirements,
    source: 'https://www.reddit.com/dev/api/#GET_search',
    description: 'Search Reddit posts globally or in a subreddit. Returns native Listing data with children and after/before cursors.',
    inputSchema: schema({
      query: text('Post search query.', 512), subreddit,
      sort: choice(['relevance', 'hot', 'top', 'new', 'comments'], 'relevance', 'Search result ordering.'),
      time, ...listingFields,
    }, ['query']),
  },
  {
    site: 'reddit', name: 'posts', readOnly: true, transport: 'official-api', requirements: redditRequirements,
    source: 'https://www.reddit.com/dev/api/#GET_hot',
    description: 'List subreddit posts. Returns native Listing data with children and after/before cursors.',
    inputSchema: schema({
      subreddit, sort: choice(['hot', 'new', 'top', 'rising', 'controversial'], 'hot', 'Subreddit post ordering.'),
      time, ...listingFields,
    }, ['subreddit']),
  },
  {
    site: 'reddit', name: 'post', readOnly: true, transport: 'official-api', requirements: redditRequirements,
    source: 'https://www.reddit.com/dev/api/#GET_by_id_{names}',
    description: 'Read one Reddit post by its base36 ID or t3_ fullname.',
    inputSchema: schema({ postId }, ['postId']),
  },
  {
    site: 'reddit', name: 'comments', readOnly: true, transport: 'official-api', requirements: redditRequirements,
    source: 'https://www.reddit.com/dev/api/#GET_comments_{article}',
    description: 'Read a bounded comment tree and its post. Returns {post, comments}; kind=more placeholders remain, so this is not a full comment export.',
    inputSchema: schema({
      postId, limit: limit('comments'),
      sort: choice(['confidence', 'top', 'new', 'controversial', 'old', 'random', 'qa', 'live'], 'confidence', 'Comment tree ordering.'),
      depth: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum comment tree depth.' },
    }, ['postId']),
  },
  {
    site: 'reddit', name: 'subreddit', readOnly: true, transport: 'official-api', requirements: redditRequirements,
    source: 'https://www.reddit.com/dev/api/#GET_r_{subreddit}_about',
    description: 'Read subreddit metadata, including description and subscriber count.',
    inputSchema: schema({ subreddit }, ['subreddit']),
  },
];
