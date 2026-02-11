/**
 * Error classes for ConnectionManager.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Transient RPC connection error after all retries on a single endpoint.
 */
export class ConnectionError extends RuntimeError {
  public readonly endpoint: string;
  public readonly httpStatus?: number;

  constructor(message: string, endpoint: string, httpStatus?: number) {
    super(message, RuntimeErrorCodes.CONNECTION_ERROR);
    this.name = 'ConnectionError';
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
  }
}

/**
 * All configured RPC endpoints are unhealthy.
 *
 * Includes per-endpoint last error for production debugging.
 */
export class AllEndpointsUnhealthyError extends RuntimeError {
  public readonly endpointCount: number;
  public readonly endpoints: { url: string; lastError: string | null }[];

  constructor(endpoints: { url: string; lastError: string | null }[]) {
    super(
      `All ${endpoints.length} RPC endpoints are unhealthy`,
      RuntimeErrorCodes.ALL_ENDPOINTS_UNHEALTHY,
    );
    this.name = 'AllEndpointsUnhealthyError';
    this.endpointCount = endpoints.length;
    this.endpoints = endpoints;
  }
}
