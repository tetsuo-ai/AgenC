/**
 * Built-in tools for common agent operations
 */

import type { Tool } from '../../types/tools';

/**
 * HTTP fetch tool for making web requests
 */
export const httpFetch: Tool = {
  name: 'http_fetch',
  description: 'Make HTTP requests to external APIs',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        description: 'HTTP method',
      },
      headers: {
        type: 'object',
        description: 'Request headers',
      },
      body: {
        type: 'string',
        description: 'Request body (for POST/PUT/PATCH)',
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in milliseconds',
      },
    },
    required: ['url'],
  },
  execute: async (input: unknown) => {
    const { url, method = 'GET', headers = {}, body, timeout = 30000 } = input as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeout?: number;
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? body : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type') ?? '';
      let data: unknown;

      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        data,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  },
};

/**
 * JSON parse tool
 */
export const jsonParse: Tool = {
  name: 'json_parse',
  description: 'Parse a JSON string into an object',
  inputSchema: {
    type: 'object',
    properties: {
      json: {
        type: 'string',
        description: 'The JSON string to parse',
      },
    },
    required: ['json'],
  },
  execute: async (input: unknown) => {
    const { json } = input as { json: string };
    return JSON.parse(json);
  },
};

/**
 * JSON stringify tool
 */
export const jsonStringify: Tool = {
  name: 'json_stringify',
  description: 'Convert an object to a JSON string',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        description: 'The data to stringify',
      },
      pretty: {
        type: 'boolean',
        description: 'Whether to format with indentation',
      },
    },
    required: ['data'],
  },
  execute: async (input: unknown) => {
    const { data, pretty = false } = input as { data: unknown; pretty?: boolean };
    return JSON.stringify(data, null, pretty ? 2 : undefined);
  },
};

/**
 * Base64 encode tool
 */
export const base64Encode: Tool = {
  name: 'base64_encode',
  description: 'Encode a string to base64',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: 'The string to encode',
      },
    },
    required: ['data'],
  },
  execute: async (input: unknown) => {
    const { data } = input as { data: string };
    return Buffer.from(data).toString('base64');
  },
};

/**
 * Base64 decode tool
 */
export const base64Decode: Tool = {
  name: 'base64_decode',
  description: 'Decode a base64 string',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: 'The base64 string to decode',
      },
    },
    required: ['data'],
  },
  execute: async (input: unknown) => {
    const { data } = input as { data: string };
    return Buffer.from(data, 'base64').toString('utf-8');
  },
};

/**
 * Hash computation tool
 */
export const computeHash: Tool = {
  name: 'compute_hash',
  description: 'Compute a hash of the input data',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: 'The data to hash',
      },
      algorithm: {
        type: 'string',
        enum: ['sha256', 'sha512', 'sha1', 'md5'],
        description: 'Hash algorithm to use',
      },
    },
    required: ['data'],
  },
  execute: async (input: unknown) => {
    const { data, algorithm = 'sha256' } = input as { data: string; algorithm?: string };

    // Use Web Crypto API
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);

    const algorithmMap: Record<string, string> = {
      sha256: 'SHA-256',
      sha512: 'SHA-512',
      sha1: 'SHA-1',
      md5: 'MD5', // Note: MD5 may not be supported in all environments
    };

    const hashBuffer = await crypto.subtle.digest(
      algorithmMap[algorithm] ?? 'SHA-256',
      dataBuffer
    );

    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  },
};

/**
 * Random number generator tool
 */
export const randomNumber: Tool = {
  name: 'random_number',
  description: 'Generate a random number',
  inputSchema: {
    type: 'object',
    properties: {
      min: {
        type: 'number',
        description: 'Minimum value (inclusive)',
      },
      max: {
        type: 'number',
        description: 'Maximum value (inclusive)',
      },
      integer: {
        type: 'boolean',
        description: 'Whether to return an integer',
      },
    },
    required: [],
  },
  execute: async (input: unknown) => {
    const { min = 0, max = 1, integer = false } = input as {
      min?: number;
      max?: number;
      integer?: boolean;
    };

    const value = Math.random() * (max - min) + min;
    return integer ? Math.floor(value) : value;
  },
};

/**
 * Current timestamp tool
 */
export const currentTime: Tool = {
  name: 'current_time',
  description: 'Get the current timestamp',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['unix', 'unix_ms', 'iso', 'utc'],
        description: 'Output format',
      },
    },
    required: [],
  },
  execute: async (input: unknown) => {
    const { format = 'unix' } = input as { format?: string };
    const now = new Date();

    switch (format) {
      case 'unix':
        return Math.floor(now.getTime() / 1000);
      case 'unix_ms':
        return now.getTime();
      case 'iso':
        return now.toISOString();
      case 'utc':
        return now.toUTCString();
      default:
        return now.getTime();
    }
  },
};

/**
 * Sleep/delay tool
 */
export const sleep: Tool = {
  name: 'sleep',
  description: 'Wait for a specified duration',
  inputSchema: {
    type: 'object',
    properties: {
      ms: {
        type: 'number',
        description: 'Duration to wait in milliseconds',
      },
    },
    required: ['ms'],
  },
  execute: async (input: unknown) => {
    const { ms } = input as { ms: number };
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { slept: ms };
  },
};

/**
 * All built-in tools
 */
export const builtinTools: Tool[] = [
  httpFetch,
  jsonParse,
  jsonStringify,
  base64Encode,
  base64Decode,
  computeHash,
  randomNumber,
  currentTime,
  sleep,
];
