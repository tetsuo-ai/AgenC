import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpTools, isDomainAllowed } from './http.js';
import { silentLogger } from '../../utils/logger.js';

// ============================================================================
// Mock fetch
// ============================================================================

function makeMockResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const headerEntries = Object.entries({
    'content-type': 'application/json',
    ...headers,
  });
  const headersObj = new Headers(headerEntries);
  return {
    status,
    statusText: status === 200 ? 'OK' : `Status ${status}`,
    ok: status >= 200 && status < 300,
    headers: headersObj,
    url: '',
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockImplementation(() => {
      try { return Promise.resolve(JSON.parse(body)); }
      catch { return Promise.reject(new SyntaxError('Invalid JSON')); }
    }),
    redirected: false,
  } as unknown as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue(makeMockResponse('{"ok":true}'));
  vi.stubGlobal('fetch', mockFetch);
});

// ============================================================================
// isDomainAllowed
// ============================================================================

describe('isDomainAllowed', () => {
  it('accepts allowed domain', () => {
    const result = isDomainAllowed('https://api.example.com/v1', ['api.example.com']);
    expect(result.allowed).toBe(true);
  });

  it('rejects blocked domain', () => {
    const result = isDomainAllowed('https://evil.com/steal', undefined, ['evil.com']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked');
  });

  it('supports wildcard patterns', () => {
    const allowed = ['*.github.com'];
    expect(isDomainAllowed('https://api.github.com/repos', allowed).allowed).toBe(true);
    // Wildcard does NOT match the bare domain
    expect(isDomainAllowed('https://github.com/repos', allowed).allowed).toBe(false);
  });

  it('blocked takes precedence over allowed', () => {
    const result = isDomainAllowed(
      'https://api.example.com/v1',
      ['api.example.com'],
      ['api.example.com'],
    );
    expect(result.allowed).toBe(false);
  });

  it('rejects non-HTTP URLs', () => {
    const result = isDomainAllowed('ftp://files.example.com/data');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('HTTP(S)');
  });

  it('allows all when no lists configured', () => {
    expect(isDomainAllowed('https://anything.com/path').allowed).toBe(true);
    expect(isDomainAllowed('http://localhost:3000/api').allowed).toBe(true);
  });
});

// ============================================================================
// system.httpGet
// ============================================================================

describe('system.httpGet', () => {
  it('makes GET request and returns response', async () => {
    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({ url: 'https://api.example.com/data' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe('{"ok":true}');
    expect(parsed.truncated).toBe(false);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [fetchUrl, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchUrl).toBe('https://api.example.com/data');
    expect(fetchInit.method).toBe('GET');
    expect(fetchInit.redirect).toBe('manual');
  });
});

// ============================================================================
// system.httpPost
// ============================================================================

describe('system.httpPost', () => {
  it('sends POST with JSON body', async () => {
    const [, httpPost] = createHttpTools({}, silentLogger);
    const body = '{"key":"value"}';
    const result = await httpPost.execute({
      url: 'https://api.example.com/submit',
      body,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe(200);

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.method).toBe('POST');
    expect(fetchInit.body).toBe(body);
    expect(fetchInit.headers['content-type']).toBe('application/json');
  });
});

// ============================================================================
// system.httpFetch
// ============================================================================

describe('system.httpFetch', () => {
  it('supports arbitrary methods', async () => {
    const [, , httpFetch] = createHttpTools({}, silentLogger);
    await httpFetch.execute({
      url: 'https://api.example.com/resource/123',
      method: 'DELETE',
    });

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.method).toBe('DELETE');
  });
});

// ============================================================================
// Response handling
// ============================================================================

describe('response handling', () => {
  it('truncates at maxResponseBytes', async () => {
    const longBody = 'x'.repeat(500);
    mockFetch.mockResolvedValueOnce(makeMockResponse(longBody));

    const [httpGet] = createHttpTools({ maxResponseBytes: 100 }, silentLogger);
    const result = await httpGet.execute({ url: 'https://example.com' });

    const parsed = JSON.parse(result.content);
    expect(parsed.truncated).toBe(true);
    expect(parsed.body.length).toBe(100);
  });
});

// ============================================================================
// Timeout
// ============================================================================

describe('timeout', () => {
  it('timeout enforcement returns error', async () => {
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeoutError);

    const [httpGet] = createHttpTools({ timeoutMs: 100 }, silentLogger);
    const result = await httpGet.execute({ url: 'https://slow.example.com' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('timed out');
  });
});

// ============================================================================
// Redirects
// ============================================================================

describe('redirects', () => {
  it('redirect to blocked domain is stopped', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'https://evil.com/trap' }),
      url: 'https://safe.com/start',
      text: vi.fn().mockResolvedValue(''),
    } as unknown as Response);

    const [httpGet] = createHttpTools(
      { blockedDomains: ['evil.com'] },
      silentLogger,
    );
    const result = await httpGet.execute({ url: 'https://safe.com/start' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('blocked');
  });
});

// ============================================================================
// Auth headers
// ============================================================================

describe('auth headers', () => {
  it('injected for matching domains', async () => {
    const [httpGet] = createHttpTools(
      {
        authHeaders: {
          '*.github.com': { Authorization: 'Bearer ghp_test123' },
        },
      },
      silentLogger,
    );
    await httpGet.execute({ url: 'https://api.github.com/repos' });

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers.Authorization).toBe('Bearer ghp_test123');
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe('error handling', () => {
  it('connection error returns isError: true', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({ url: 'https://down.example.com' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Connection failed');
    expect(parsed.error).toContain('ECONNREFUSED');
  });
});
