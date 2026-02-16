/**
 * Gateway connection management service.
 *
 * Handles URL and token storage for connecting to a remote Gateway.
 * In a production app this would persist to AsyncStorage or SecureStore.
 */

import type { GatewayConnection } from '../types';

let currentConnection: GatewayConnection | null = null;

export function getConnection(): GatewayConnection | null {
  return currentConnection;
}

export function setConnection(url: string, token: string): GatewayConnection {
  currentConnection = { url, token };
  return currentConnection;
}

export function clearConnection(): void {
  currentConnection = null;
}

export function isConfigured(): boolean {
  return currentConnection !== null;
}
