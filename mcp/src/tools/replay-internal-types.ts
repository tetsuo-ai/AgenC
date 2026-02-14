import { type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

export type ReplayToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification> | undefined;
