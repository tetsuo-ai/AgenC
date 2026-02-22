/**
 * X (Twitter) API tools for the AgenC runtime.
 *
 * Full suite: post, delete, like, unlike, retweet, unretweet, follow, unfollow,
 * search, user lookup, timeline, profile update, mentions, own profile.
 *
 * Uses Twitter API v2 (and v1.1 for profile updates) with OAuth 1.0a User Context.
 *
 * @module
 */

import { createHmac, randomBytes } from 'node:crypto';
import type { Tool, ToolResult } from '../types.js';
import type { Logger } from '../../utils/logger.js';

// ============================================================================
// OAuth 1.0a signing
// ============================================================================

export interface XCredentials {
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly accessToken: string;
  readonly accessTokenSecret: string;
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuthHeader(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: XCredentials,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  const allParams = { ...params, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`).join('&');

  const signatureBase = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${headerParts}`;
}

// ============================================================================
// Helpers
// ============================================================================

let cachedUserId: string | null = null;

async function resolveUserId(creds: XCredentials): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const meUrl = 'https://api.x.com/2/users/me';
  const authHeader = buildOAuthHeader('GET', meUrl, {}, creds);
  const response = await fetch(meUrl, { headers: { Authorization: authHeader } });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Failed to get user info: ${response.status}`);
  const data = result.data as Record<string, string> | undefined;
  if (!data?.id) throw new Error('Could not resolve user ID');
  cachedUserId = data.id;
  return cachedUserId;
}

async function resolveUserIdByUsername(username: string, creds: XCredentials): Promise<string> {
  const clean = username.replace(/^@/, '');
  const url = `https://api.x.com/2/users/by/username/${clean}`;
  const authHeader = buildOAuthHeader('GET', url, {}, creds);
  const response = await fetch(url, { headers: { Authorization: authHeader } });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`User lookup failed: ${response.status}`);
  const data = result.data as Record<string, string> | undefined;
  if (!data?.id) throw new Error(`User @${clean} not found`);
  return data.id;
}

function ok(data: unknown): ToolResult {
  return { content: JSON.stringify(data) };
}

function err(msg: string, details?: unknown): ToolResult {
  return { content: JSON.stringify({ error: msg, ...(details ? { details } : {}) }), isError: true };
}

// ============================================================================
// x.post — Post a tweet
// ============================================================================

export function createPostTweetTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.post',
    description: 'Post a tweet to X (Twitter) from the @a_g_e_n_c account.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The tweet text (max 280 characters)' },
        replyToId: { type: 'string', description: 'Optional: tweet ID to reply to' },
        quoteId: { type: 'string', description: 'Optional: tweet ID to quote-tweet' },
      },
      required: ['text'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const text = args.text as string | undefined;
      if (!text || text.trim().length === 0) return err('Tweet text is required');
      if (text.length > 280) return err(`Tweet too long: ${text.length}/280 characters`);

      const url = 'https://api.x.com/2/tweets';
      const body: Record<string, unknown> = { text };
      if (args.replyToId) body.reply = { in_reply_to_tweet_id: args.replyToId as string };
      if (args.quoteId) body.quote_tweet_id = args.quoteId as string;

      const authHeader = buildOAuthHeader('POST', url, {}, creds);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) { logger.error('X API error:', result); return err(`X API error ${response.status}`, result); }

        const data = result.data as Record<string, string> | undefined;
        logger.info('Tweet posted', { tweetId: data?.id });
        return ok({ success: true, tweetId: data?.id, tweetUrl: data?.id ? `https://x.com/a_g_e_n_c/status/${data.id}` : undefined, text });
      } catch (error) {
        logger.error('x.post failed:', error);
        return err(`Failed to post: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.deleteTweet — Delete a tweet
// ============================================================================

export function createDeleteTweetTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.deleteTweet',
    description: 'Delete a tweet from the @a_g_e_n_c account.',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: 'The ID of the tweet to delete' },
      },
      required: ['tweetId'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tweetId = args.tweetId as string;
      if (!tweetId) return err('tweetId is required');

      const url = `https://api.x.com/2/tweets/${tweetId}`;
      const authHeader = buildOAuthHeader('DELETE', url, {}, creds);

      try {
        const response = await fetch(url, { method: 'DELETE', headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Delete failed: ${response.status}`, result);

        logger.info('Tweet deleted', { tweetId });
        return ok({ success: true, tweetId, deleted: (result.data as Record<string, boolean>)?.deleted });
      } catch (error) {
        logger.error('x.deleteTweet failed:', error);
        return err(`Failed to delete: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.like — Like a tweet
// ============================================================================

export function createLikeTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.like',
    description: 'Like a tweet on X.',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: 'The ID of the tweet to like' },
      },
      required: ['tweetId'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tweetId = args.tweetId as string;
      if (!tweetId) return err('tweetId is required');

      try {
        const userId = await resolveUserId(creds);
        const url = `https://api.x.com/2/users/${userId}/likes`;
        const authHeader = buildOAuthHeader('POST', url, {}, creds);

        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tweet_id: tweetId }),
        });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Like failed: ${response.status}`, result);

        logger.info('Tweet liked', { tweetId });
        return ok({ success: true, tweetId, liked: (result.data as Record<string, boolean>)?.liked });
      } catch (error) {
        logger.error('x.like failed:', error);
        return err(`Failed to like: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.unlike — Unlike a tweet
// ============================================================================

export function createUnlikeTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.unlike',
    description: 'Unlike a previously liked tweet on X.',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: 'The ID of the tweet to unlike' },
      },
      required: ['tweetId'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tweetId = args.tweetId as string;
      if (!tweetId) return err('tweetId is required');

      try {
        const userId = await resolveUserId(creds);
        const url = `https://api.x.com/2/users/${userId}/likes/${tweetId}`;
        const authHeader = buildOAuthHeader('DELETE', url, {}, creds);

        const response = await fetch(url, { method: 'DELETE', headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Unlike failed: ${response.status}`, result);

        logger.info('Tweet unliked', { tweetId });
        return ok({ success: true, tweetId });
      } catch (error) {
        logger.error('x.unlike failed:', error);
        return err(`Failed to unlike: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.retweet — Retweet
// ============================================================================

export function createRetweetTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.retweet',
    description: 'Retweet a tweet on X.',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: 'The ID of the tweet to retweet' },
      },
      required: ['tweetId'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tweetId = args.tweetId as string;
      if (!tweetId) return err('tweetId is required');

      try {
        const userId = await resolveUserId(creds);
        const url = `https://api.x.com/2/users/${userId}/retweets`;
        const authHeader = buildOAuthHeader('POST', url, {}, creds);

        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tweet_id: tweetId }),
        });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Retweet failed: ${response.status}`, result);

        logger.info('Retweeted', { tweetId });
        return ok({ success: true, tweetId, retweeted: (result.data as Record<string, boolean>)?.retweeted });
      } catch (error) {
        logger.error('x.retweet failed:', error);
        return err(`Failed to retweet: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.unretweet — Undo retweet
// ============================================================================

export function createUnretweetTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.unretweet',
    description: 'Undo a retweet on X.',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: 'The ID of the tweet to unretweet' },
      },
      required: ['tweetId'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tweetId = args.tweetId as string;
      if (!tweetId) return err('tweetId is required');

      try {
        const userId = await resolveUserId(creds);
        const url = `https://api.x.com/2/users/${userId}/retweets/${tweetId}`;
        const authHeader = buildOAuthHeader('DELETE', url, {}, creds);

        const response = await fetch(url, { method: 'DELETE', headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Unretweet failed: ${response.status}`, result);

        logger.info('Unretweeted', { tweetId });
        return ok({ success: true, tweetId });
      } catch (error) {
        logger.error('x.unretweet failed:', error);
        return err(`Failed to unretweet: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.follow — Follow a user
// ============================================================================

export function createFollowTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.follow',
    description: 'Follow a user on X. Accepts a username (e.g. @solana) or user ID.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username to follow (e.g. "solana" or "@solana")' },
        userId: { type: 'string', description: 'User ID to follow (alternative to username)' },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const myId = await resolveUserId(creds);
        let targetId = args.userId as string | undefined;
        const username = args.username as string | undefined;

        if (!targetId && !username) return err('Provide either username or userId');
        if (!targetId && username) targetId = await resolveUserIdByUsername(username, creds);

        const url = `https://api.x.com/2/users/${myId}/following`;
        const authHeader = buildOAuthHeader('POST', url, {}, creds);

        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_user_id: targetId }),
        });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Follow failed: ${response.status}`, result);

        logger.info('Followed user', { targetId, username });
        return ok({ success: true, targetId, username, following: (result.data as Record<string, boolean>)?.following });
      } catch (error) {
        logger.error('x.follow failed:', error);
        return err(`Failed to follow: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.unfollow — Unfollow a user
// ============================================================================

export function createUnfollowTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.unfollow',
    description: 'Unfollow a user on X. Accepts a username or user ID.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username to unfollow' },
        userId: { type: 'string', description: 'User ID to unfollow (alternative to username)' },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const myId = await resolveUserId(creds);
        let targetId = args.userId as string | undefined;
        const username = args.username as string | undefined;

        if (!targetId && !username) return err('Provide either username or userId');
        if (!targetId && username) targetId = await resolveUserIdByUsername(username, creds);

        const url = `https://api.x.com/2/users/${myId}/following/${targetId}`;
        const authHeader = buildOAuthHeader('DELETE', url, {}, creds);

        const response = await fetch(url, { method: 'DELETE', headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Unfollow failed: ${response.status}`, result);

        logger.info('Unfollowed user', { targetId, username });
        return ok({ success: true, targetId, username });
      } catch (error) {
        logger.error('x.unfollow failed:', error);
        return err(`Failed to unfollow: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.search — Search recent tweets
// ============================================================================

export function createSearchTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.search',
    description: 'Search recent tweets on X. Returns tweets from the last 7 days matching the query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "solana", "from:solana", "#web3")' },
        maxResults: { type: 'number', description: 'Number of results (10-100, default 10)' },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = args.query as string;
      if (!query) return err('query is required');

      const maxResults = Math.min(100, Math.max(10, (args.maxResults as number) || 10));
      const url = 'https://api.x.com/2/tweets/search/recent';
      const queryParams: Record<string, string> = {
        query,
        max_results: maxResults.toString(),
        'tweet.fields': 'created_at,author_id,public_metrics,text',
      };
      const queryString = new URLSearchParams(queryParams).toString();
      const authHeader = buildOAuthHeader('GET', url, queryParams, creds);

      try {
        const response = await fetch(`${url}?${queryString}`, { headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Search failed: ${response.status}`, result);

        const tweets = result.data as unknown[] | undefined;
        logger.info('Search completed', { query, count: tweets?.length ?? 0 });
        return ok({ query, count: tweets?.length ?? 0, tweets: tweets ?? [], meta: result.meta });
      } catch (error) {
        logger.error('x.search failed:', error);
        return err(`Search failed: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.getUserTweets — Get a user's recent tweets
// ============================================================================

export function createGetUserTweetsTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.getUserTweets',
    description: 'Get recent tweets from a specific X user by username.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username (e.g. "solana" or "@solana")' },
        maxResults: { type: 'number', description: 'Number of tweets (5-100, default 10)' },
      },
      required: ['username'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const username = args.username as string;
      if (!username) return err('username is required');

      try {
        const userId = await resolveUserIdByUsername(username, creds);
        const maxResults = Math.min(100, Math.max(5, (args.maxResults as number) || 10));

        const url = `https://api.x.com/2/users/${userId}/tweets`;
        const queryParams: Record<string, string> = {
          max_results: maxResults.toString(),
          'tweet.fields': 'created_at,public_metrics,text',
        };
        const queryString = new URLSearchParams(queryParams).toString();
        const authHeader = buildOAuthHeader('GET', url, queryParams, creds);

        const response = await fetch(`${url}?${queryString}`, { headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Failed to get tweets: ${response.status}`, result);

        const tweets = result.data as unknown[] | undefined;
        logger.info('Got user tweets', { username, count: tweets?.length ?? 0 });
        return ok({ username, userId, count: tweets?.length ?? 0, tweets: tweets ?? [] });
      } catch (error) {
        logger.error('x.getUserTweets failed:', error);
        return err(`Failed to get tweets: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.getUser — Look up a user by username
// ============================================================================

export function createGetUserTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.getUser',
    description: 'Look up an X user by username. Returns profile info, follower counts, bio.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username to look up (e.g. "solana" or "@solana")' },
      },
      required: ['username'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const username = (args.username as string)?.replace(/^@/, '');
      if (!username) return err('username is required');

      const url = `https://api.x.com/2/users/by/username/${username}`;
      const queryParams: Record<string, string> = {
        'user.fields': 'created_at,description,location,public_metrics,verified,profile_image_url,url',
      };
      const queryString = new URLSearchParams(queryParams).toString();
      const authHeader = buildOAuthHeader('GET', url, queryParams, creds);

      try {
        const response = await fetch(`${url}?${queryString}`, { headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`User lookup failed: ${response.status}`, result);

        logger.info('User lookup', { username });
        return ok(result.data);
      } catch (error) {
        logger.error('x.getUser failed:', error);
        return err(`User lookup failed: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.getMe — Get own profile info
// ============================================================================

export function createGetMeTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.getMe',
    description: 'Get the @a_g_e_n_c account profile info (bio, location, followers, etc).',
    inputSchema: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      const url = 'https://api.x.com/2/users/me';
      const queryParams: Record<string, string> = {
        'user.fields': 'created_at,description,location,public_metrics,verified,profile_image_url,url,pinned_tweet_id',
      };
      const queryString = new URLSearchParams(queryParams).toString();
      const authHeader = buildOAuthHeader('GET', url, queryParams, creds);

      try {
        const response = await fetch(`${url}?${queryString}`, { headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`getMe failed: ${response.status}`, result);

        logger.info('Profile fetched');
        return ok(result.data);
      } catch (error) {
        logger.error('x.getMe failed:', error);
        return err(`Failed to get profile: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.updateProfile — Update bio, location, name, url
// ============================================================================

export function createUpdateProfileTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.updateProfile',
    description: 'Update the @a_g_e_n_c X profile. Can change name, bio (description), location, and website URL.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (max 50 chars)' },
        description: { type: 'string', description: 'Bio text (max 160 chars)' },
        location: { type: 'string', description: 'Location text (max 30 chars)' },
        url: { type: 'string', description: 'Website URL' },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const params: Record<string, string> = {};
      if (args.name !== undefined) params.name = String(args.name);
      if (args.description !== undefined) params.description = String(args.description);
      if (args.location !== undefined) params.location = String(args.location);
      if (args.url !== undefined) params.url = String(args.url);

      if (Object.keys(params).length === 0) return err('Provide at least one field to update (name, description, location, url)');

      // v1.1 endpoint — form-encoded, params included in OAuth signature
      const url = 'https://api.x.com/1.1/account/update_profile.json';
      const authHeader = buildOAuthHeader('POST', url, params, creds);
      const body = new URLSearchParams(params).toString();

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Profile update failed: ${response.status}`, result);

        logger.info('Profile updated', { fields: Object.keys(params) });
        return ok({
          success: true,
          updated: Object.keys(params),
          name: result.name,
          description: result.description,
          location: result.location,
          url: result.url,
        });
      } catch (error) {
        logger.error('x.updateProfile failed:', error);
        return err(`Profile update failed: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.mentions — Get recent mentions
// ============================================================================

export function createGetMentionsTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.mentions',
    description: 'Get recent mentions of the @a_g_e_n_c account on X.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Number of mentions to return (5-100, default 10)' },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const maxResults = Math.min(100, Math.max(5, (args.maxResults as number) || 10));

      try {
        const userId = await resolveUserId(creds);
        const mentionsUrl = `https://api.x.com/2/users/${userId}/mentions`;
        const queryParams = { max_results: maxResults.toString(), 'tweet.fields': 'created_at,author_id,text,public_metrics' };
        const queryString = new URLSearchParams(queryParams).toString();
        const mentionsAuth = buildOAuthHeader('GET', mentionsUrl, queryParams, creds);

        const response = await fetch(`${mentionsUrl}?${queryString}`, { headers: { Authorization: mentionsAuth } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Mentions failed: ${response.status}`, result);

        const mentions = result.data as unknown[] | undefined;
        logger.info('Fetched mentions', { count: mentions?.length ?? 0 });
        return ok({ count: mentions?.length ?? 0, mentions: mentions ?? [], meta: result.meta });
      } catch (error) {
        logger.error('x.mentions failed:', error);
        return err(`Failed to fetch mentions: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.getMyTweets — Get own recent tweets
// ============================================================================

export function createGetMyTweetsTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.getMyTweets',
    description: 'Get the @a_g_e_n_c account\'s own recent tweets.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Number of tweets (5-100, default 10)' },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const userId = await resolveUserId(creds);
        const maxResults = Math.min(100, Math.max(5, (args.maxResults as number) || 10));

        const url = `https://api.x.com/2/users/${userId}/tweets`;
        const queryParams: Record<string, string> = {
          max_results: maxResults.toString(),
          'tweet.fields': 'created_at,public_metrics,text',
        };
        const queryString = new URLSearchParams(queryParams).toString();
        const authHeader = buildOAuthHeader('GET', url, queryParams, creds);

        const response = await fetch(`${url}?${queryString}`, { headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Failed: ${response.status}`, result);

        const tweets = result.data as unknown[] | undefined;
        logger.info('Got own tweets', { count: tweets?.length ?? 0 });
        return ok({ count: tweets?.length ?? 0, tweets: tweets ?? [] });
      } catch (error) {
        logger.error('x.getMyTweets failed:', error);
        return err(`Failed: ${(error as Error).message}`);
      }
    },
  };
}

// ============================================================================
// x.getTweet — Get a single tweet by ID
// ============================================================================

export function createGetTweetTool(creds: XCredentials, logger: Logger): Tool {
  return {
    name: 'x.getTweet',
    description: 'Get a single tweet by its ID, including metrics and author info.',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: 'The tweet ID to look up' },
      },
      required: ['tweetId'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tweetId = args.tweetId as string;
      if (!tweetId) return err('tweetId is required');

      const url = `https://api.x.com/2/tweets/${tweetId}`;
      const queryParams: Record<string, string> = {
        'tweet.fields': 'created_at,author_id,public_metrics,text,conversation_id,in_reply_to_user_id',
        expansions: 'author_id',
        'user.fields': 'username,name,verified',
      };
      const queryString = new URLSearchParams(queryParams).toString();
      const authHeader = buildOAuthHeader('GET', url, queryParams, creds);

      try {
        const response = await fetch(`${url}?${queryString}`, { headers: { Authorization: authHeader } });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) return err(`Tweet lookup failed: ${response.status}`, result);

        logger.info('Tweet fetched', { tweetId });
        return ok(result);
      } catch (error) {
        logger.error('x.getTweet failed:', error);
        return err(`Tweet lookup failed: ${(error as Error).message}`);
      }
    },
  };
}
