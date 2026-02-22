/**
 * X (Twitter) tools for the AgenC runtime.
 *
 * @module
 */

import type { Tool } from '../types.js';
import type { Logger } from '../../utils/logger.js';
import {
  createPostTweetTool,
  createDeleteTweetTool,
  createGetMentionsTool,
  createLikeTool,
  createUnlikeTool,
  createRetweetTool,
  createUnretweetTool,
  createFollowTool,
  createUnfollowTool,
  createSearchTool,
  createGetUserTweetsTool,
  createGetUserTool,
  createGetMeTool,
  createUpdateProfileTool,
  createGetMyTweetsTool,
  createGetTweetTool,
} from './tools.js';
import type { XCredentials } from './tools.js';

export type { XCredentials } from './tools.js';
export {
  createPostTweetTool,
  createDeleteTweetTool,
  createGetMentionsTool,
  createLikeTool,
  createUnlikeTool,
  createRetweetTool,
  createUnretweetTool,
  createFollowTool,
  createUnfollowTool,
  createSearchTool,
  createGetUserTweetsTool,
  createGetUserTool,
  createGetMeTool,
  createUpdateProfileTool,
  createGetMyTweetsTool,
  createGetTweetTool,
} from './tools.js';

/**
 * Create all X (Twitter) tools.
 *
 * @param creds - OAuth 1.0a credentials
 * @param logger - Logger instance
 * @returns Array of X tools
 */
export function createXTools(creds: XCredentials, logger: Logger): Tool[] {
  return [
    createPostTweetTool(creds, logger),
    createDeleteTweetTool(creds, logger),
    createGetMentionsTool(creds, logger),
    createLikeTool(creds, logger),
    createUnlikeTool(creds, logger),
    createRetweetTool(creds, logger),
    createUnretweetTool(creds, logger),
    createFollowTool(creds, logger),
    createUnfollowTool(creds, logger),
    createSearchTool(creds, logger),
    createGetUserTweetsTool(creds, logger),
    createGetUserTool(creds, logger),
    createGetMeTool(creds, logger),
    createUpdateProfileTool(creds, logger),
    createGetMyTweetsTool(creds, logger),
    createGetTweetTool(creds, logger),
  ];
}
