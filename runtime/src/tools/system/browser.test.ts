import { describe, it, expect, vi, beforeEach } from 'vitest';
import { silentLogger } from '../../utils/logger.js';

// ============================================================================
// Mock cheerio — intercept import('cheerio') used by ensureLazyModule
// ============================================================================

interface MockItem {
  text: string;
  html?: string;
  href?: string;
  tagName?: string;
  __children?: Record<string, MockItem[]>;
}

/** Create a cheerio-like selection mock. */
function makeSelection(opts: {
  text?: string;
  html?: string;
  href?: string;
  items?: MockItem[];
  children?: Record<string, MockItem[]>;
}): Record<string, unknown> {
  const sel: Record<string, unknown> = {
    text: vi.fn().mockReturnValue(opts.text ?? ''),
    html: vi.fn().mockReturnValue(opts.html ?? opts.text ?? null),
    attr: vi.fn().mockImplementation((name: string) =>
      name === 'href' ? (opts.href ?? undefined) : undefined,
    ),
    find: vi.fn().mockImplementation((selector: string) => {
      if (opts.children?.[selector]) {
        return makeSelection({ items: opts.children[selector] });
      }
      return makeSelection({});
    }),
    each: vi.fn().mockImplementation((fn: (i: number, el: unknown) => void) => {
      if (opts.items) {
        opts.items.forEach((item, i) => fn(i, {
          __text: item.text,
          __html: item.html ?? item.text,
          __href: item.href,
          tagName: item.tagName,
          __children: item.__children,
        }));
      }
      return sel;
    }),
    length: opts.items?.length ?? (opts.text ? 1 : 0),
  };
  return sel;
}

/**
 * Build a mock cheerio `$` function from parsed HTML.
 * Parses simple patterns: <title>, <h1>-<h6>, <p>, <li>, <pre>, <blockquote>, <a>.
 */
function buildMockCheerio(html: string) {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1] : '';

  const links: Array<{ text: string; href: string }> = [];
  let m: RegExpExecArray | null;
  const linkRe = /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  while ((m = linkRe.exec(html)) !== null) links.push({ href: m[1], text: m[2] });

  // Headings: store per-level and all in document order
  const headingsPerLevel: Record<number, Array<{ text: string; html: string }>> = {};
  const allHeadings: Array<{ level: number; text: string; html: string }> = [];
  const hRe = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
  while ((m = hRe.exec(html)) !== null) {
    const lvl = parseInt(m[1], 10);
    const rawHtml = m[2];
    const text = rawHtml.replace(/<[^>]*>/g, '');
    const item = { text, html: rawHtml };
    (headingsPerLevel[lvl] ??= []).push(item);
    allHeadings.push({ level: lvl, ...item });
  }

  const paragraphs: Array<{ text: string; html: string }> = [];
  const pRe = /<p[^>]*>(.*?)<\/p>/gi;
  while ((m = pRe.exec(html)) !== null) {
    const rawHtml = m[1];
    paragraphs.push({ html: rawHtml, text: rawHtml.replace(/<[^>]*>/g, '') });
  }

  const listItems: Array<{ text: string; html: string }> = [];
  const liRe = /<li[^>]*>(.*?)<\/li>/gi;
  while ((m = liRe.exec(html)) !== null) {
    const rawHtml = m[1];
    listItems.push({ html: rawHtml, text: rawHtml.replace(/<[^>]*>/g, '') });
  }

  const codeBlocks: Array<{ text: string; html: string }> = [];
  const preRe = /<pre[^>]*>(.*?)<\/pre>/gis;
  while ((m = preRe.exec(html)) !== null) {
    const rawHtml = m[1];
    const text = rawHtml.replace(/<\/?code[^>]*>/gi, '');
    codeBlocks.push({ html: rawHtml, text });
  }

  const blockquotes: Array<{ text: string; html: string }> = [];
  const bqRe = /<blockquote[^>]*>(.*?)<\/blockquote>/gi;
  while ((m = bqRe.exec(html)) !== null) {
    const rawHtml = m[1];
    blockquotes.push({ html: rawHtml, text: rawHtml.replace(/<[^>]*>/g, '') });
  }

  // Parse <ul> blocks and their <li> items
  const ulItems: MockItem[] = [];
  const ulRe = /<ul[^>]*>(.*?)<\/ul>/gis;
  while ((m = ulRe.exec(html)) !== null) {
    const ulHtml = m[1];
    const liInUlRe = /<li[^>]*>(.*?)<\/li>/gi;
    let liMatch: RegExpExecArray | null;
    while ((liMatch = liInUlRe.exec(ulHtml)) !== null) {
      ulItems.push({ html: liMatch[1], text: liMatch[1].replace(/<[^>]*>/g, '') });
    }
  }

  // Parse <ol> blocks with nested <li> items
  const olBlocks: MockItem[] = [];
  const olRe = /<ol[^>]*>(.*?)<\/ol>/gis;
  while ((m = olRe.exec(html)) !== null) {
    const olHtml = m[1];
    const liItems: MockItem[] = [];
    const liInOlRe = /<li[^>]*>(.*?)<\/li>/gi;
    let liMatch: RegExpExecArray | null;
    while ((liMatch = liInOlRe.exec(olHtml)) !== null) {
      liItems.push({ html: liMatch[1], text: liMatch[1].replace(/<[^>]*>/g, ''), tagName: 'li' });
    }
    olBlocks.push({ text: '', html: m[0], tagName: 'ol', __children: { 'li': liItems } });
  }

  // Parse <table> blocks with <tr> and <th>/<td> cells
  const tableBlocks: MockItem[] = [];
  const tableRe = /<table[^>]*>(.*?)<\/table>/gis;
  while ((m = tableRe.exec(html)) !== null) {
    const tableHtml = m[1];
    const trItems: MockItem[] = [];
    const trRe = /<tr[^>]*>(.*?)<\/tr>/gis;
    let trMatch: RegExpExecArray | null;
    while ((trMatch = trRe.exec(tableHtml)) !== null) {
      const trHtml = trMatch[1];
      const cellItems: MockItem[] = [];
      const cellRe = /<(th|td)[^>]*>(.*?)<\/(?:th|td)>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(trHtml)) !== null) {
        cellItems.push({ html: cellMatch[2], text: cellMatch[2].replace(/<[^>]*>/g, ''), tagName: cellMatch[1].toLowerCase() });
      }
      trItems.push({ text: '', html: trMatch[0], tagName: 'tr', __children: { 'th, td': cellItems } });
    }
    tableBlocks.push({ text: '', html: m[0], tagName: 'table', __children: { 'tr': trItems } });
  }

  // $ function
  const $ = function (selectorOrEl: unknown) {
    if (typeof selectorOrEl === 'string') {
      const s = selectorOrEl;
      if (s === 'title') return makeSelection({ text: titleText, items: titleText ? [{ text: titleText }] : [] });
      if (s === 'body') return makeSelection({ text: paragraphs.map((p) => p.text).join(' '), items: paragraphs.length ? [{ text: '' }] : [] });
      if (s === 'a') return makeSelection({ items: links.map((l) => ({ text: l.text, href: l.href })) });

      // Combined heading selector: 'h1, h2, h3, h4, h5, h6'
      if (/^h[1-6](?:\s*,\s*h[1-6])*$/.test(s)) {
        const requestedLevels = new Set(
          s.split(',').map((p) => parseInt(p.trim().replace('h', ''), 10)),
        );
        const items = allHeadings
          .filter((h) => requestedLevels.has(h.level))
          .map((h) => ({ text: h.text, html: h.html, tagName: `h${h.level}` }));
        return makeSelection({ items });
      }

      // Single heading selector
      const hMatch = s.match(/^h([1-6])$/);
      if (hMatch) {
        const lvl = parseInt(hMatch[1], 10);
        const hItems = headingsPerLevel[lvl] ?? [];
        return makeSelection({ items: hItems.map((h) => ({ text: h.text, html: h.html, tagName: `h${lvl}` })) });
      }

      if (s === 'p') return makeSelection({ items: paragraphs.map((p) => ({ text: p.text, html: p.html })) });
      if (s === 'li') return makeSelection({ items: listItems.map((li) => ({ text: li.text, html: li.html })) });
      if (s === 'ul > li') return makeSelection({ items: ulItems });
      if (s === 'ol') return makeSelection({ items: olBlocks });
      if (s === 'table') return makeSelection({ items: tableBlocks });
      if (s === 'pre') return makeSelection({ items: codeBlocks.map((c) => ({ text: c.text, html: c.html })) });
      if (s === 'blockquote') return makeSelection({ items: blockquotes.map((b) => ({ text: b.text, html: b.html })) });
      if (s === 'script' || s === 'style') return makeSelection({});

      return makeSelection({});
    }

    // Element wrapping: $(el) where el came from each() callback
    if (typeof selectorOrEl === 'object' && selectorOrEl !== null) {
      const el = selectorOrEl as { __text?: string; __html?: string; __href?: string; tagName?: string; __children?: Record<string, MockItem[]> };
      return makeSelection({ text: el.__text ?? '', html: el.__html ?? el.__text ?? '', href: el.__href, children: el.__children });
    }

    return makeSelection({});
  };

  ($ as Record<string, unknown>).root = vi.fn().mockReturnValue(makeSelection({ text: '' }));
  ($ as Record<string, unknown>).html = vi.fn().mockReturnValue(html);

  return $;
}

vi.mock('cheerio', () => ({
  load: vi.fn().mockImplementation((html: string) => buildMockCheerio(html)),
}));

// ============================================================================
// Mock playwright
// ============================================================================

const mockPage = {
  setViewportSize: vi.fn().mockResolvedValue(undefined),
  goto: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
  pdf: vi.fn().mockResolvedValue(Buffer.from('fake-pdf-data')),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue('eval-result'),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
};

const mockBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockLaunch = vi.fn().mockResolvedValue(mockBrowser);

vi.mock('playwright', () => ({
  chromium: {
    launch: mockLaunch,
  },
}));

// ============================================================================
// Mock fetch
// ============================================================================

function makeHtmlResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const allHeaders = { 'content-type': 'text/html; charset=utf-8', ...headers };
  const headersObj = new Headers(Object.entries(allHeaders));
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  return {
    status,
    statusText: status === 200 ? 'OK' : `Status ${status}`,
    ok: status >= 200 && status < 300,
    headers: headersObj,
    url: '',
    text: vi.fn().mockResolvedValue(body),
    body: stream,
    redirected: false,
  } as unknown as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

// ============================================================================
// Import after mocks
// ============================================================================

const { createBrowserTools, closeBrowser, sanitizeHref, _resetForTesting } =
  await import('./browser.js');

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue(
    makeHtmlResponse('<html><head><title>Test</title></head><body><p>Hello World</p></body></html>'),
  );
  vi.stubGlobal('fetch', mockFetch);

  _resetForTesting();

  mockPage.setViewportSize.mockClear();
  mockPage.goto.mockClear();
  mockPage.screenshot.mockClear().mockResolvedValue(Buffer.from('fake-png-data'));
  mockPage.pdf.mockClear().mockResolvedValue(Buffer.from('fake-pdf-data'));
  mockPage.click.mockClear();
  mockPage.fill.mockClear();
  mockPage.evaluate.mockClear().mockResolvedValue('eval-result');
  mockPage.waitForSelector.mockClear();
  mockPage.close.mockClear();
  mockPage.mouse.wheel.mockClear();
  mockBrowser.newPage.mockClear().mockResolvedValue(mockPage);
  mockBrowser.close.mockClear();
  mockLaunch.mockClear().mockResolvedValue(mockBrowser);
});

// ============================================================================
// Factory
// ============================================================================

describe('createBrowserTools', () => {
  it('basic mode creates 3 tools', () => {
    const tools = createBrowserTools({ mode: 'basic' }, silentLogger);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      'system.browse',
      'system.extractLinks',
      'system.htmlToMarkdown',
    ]);
  });

  it('advanced mode creates 7 tools', () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    expect(tools).toHaveLength(7);
    expect(tools.map((t) => t.name)).toEqual([
      'system.browse',
      'system.extractLinks',
      'system.htmlToMarkdown',
      'system.screenshot',
      'system.browserAction',
      'system.evaluateJs',
      'system.exportPdf',
    ]);
  });

  it('defaults to basic mode', () => {
    const tools = createBrowserTools(undefined, silentLogger);
    expect(tools).toHaveLength(3);
  });

  it('throws on invalid mode', () => {
    expect(() =>
      createBrowserTools({ mode: 'invalid' as 'basic' }, silentLogger),
    ).toThrow('Invalid browser tool mode');
  });

  it('throws on invalid maxResponseBytes', () => {
    expect(() =>
      createBrowserTools({ mode: 'basic', maxResponseBytes: -1 }, silentLogger),
    ).toThrow('maxResponseBytes must be a positive number');
  });

  it('throws on invalid timeoutMs', () => {
    expect(() =>
      createBrowserTools({ mode: 'basic', timeoutMs: 0 }, silentLogger),
    ).toThrow('timeoutMs must be a positive number');
  });
});

// ============================================================================
// system.browse
// ============================================================================

describe('system.browse', () => {
  it('fetches and extracts text from HTML', async () => {
    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://example.com' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.text).toBeDefined();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('respects domain blocklist', async () => {
    const [browse] = createBrowserTools(
      { mode: 'basic', blockedDomains: ['evil.com'] },
      silentLogger,
    );
    const result = await browse.execute({ url: 'https://evil.com/page' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('blocked');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid URL', async () => {
    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'not-a-url' });

    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing URL', async () => {
    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Missing or invalid url');
  });

  it('handles timeout errors', async () => {
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeoutError);

    const [browse] = createBrowserTools(
      { mode: 'basic', timeoutMs: 100 },
      silentLogger,
    );
    const result = await browse.execute({ url: 'https://slow.example.com' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('timed out');
  });

  it('handles connection errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://down.example.com' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Connection failed');
  });

  it('truncates at maxResponseBytes', async () => {
    const longBody = '<html><body>' + 'x'.repeat(500) + '</body></html>';
    mockFetch.mockResolvedValueOnce(makeHtmlResponse(longBody));

    const [browse] = createBrowserTools(
      { mode: 'basic', maxResponseBytes: 50 },
      silentLogger,
    );
    const result = await browse.execute({ url: 'https://example.com' });

    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('notes non-HTML content type', async () => {
    mockFetch.mockResolvedValueOnce(
      makeHtmlResponse('{"data": "json"}', 200, { 'content-type': 'application/json' }),
    );

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://api.example.com/data' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain('Content-Type');
  });

  it('includes links when requested', async () => {
    mockFetch.mockResolvedValueOnce(
      makeHtmlResponse(
        '<html><body><a href="https://example.com/link1">Link 1</a></body></html>',
      ),
    );

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({
      url: 'https://example.com',
      includeLinks: true,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain('Links');
  });

  it('returns empty text for empty page', async () => {
    mockFetch.mockResolvedValueOnce(makeHtmlResponse('<html><body></body></html>'));

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://example.com/empty' });

    expect(result.isError).toBeUndefined();
  });

  it('renders 404 page content without error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeHtmlResponse('<html><body><h1>Not Found</h1><p>Page missing</p></body></html>', 404),
    );

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://example.com/missing' });

    // Non-2xx pages are rendered, not treated as errors (mirrors browser behavior)
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain('Not Found');
  });
});

// ============================================================================
// system.extractLinks
// ============================================================================

describe('system.extractLinks', () => {
  it('extracts links from a page', async () => {
    mockFetch.mockResolvedValueOnce(
      makeHtmlResponse(
        '<html><body>' +
        '<a href="https://example.com/one">One</a>' +
        '<a href="https://example.com/two">Two</a>' +
        '</body></html>',
      ),
    );

    const [, extractLinks] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await extractLinks.execute({ url: 'https://example.com' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.links).toHaveLength(2);
    expect(parsed.links[0]).toEqual({ text: 'One', href: 'https://example.com/one' });
    expect(parsed.links[1]).toEqual({ text: 'Two', href: 'https://example.com/two' });
  });

  it('filters links by text', async () => {
    mockFetch.mockResolvedValueOnce(
      makeHtmlResponse(
        '<html><body>' +
        '<a href="https://example.com/docs">Documentation</a>' +
        '<a href="https://example.com/about">About Us</a>' +
        '</body></html>',
      ),
    );

    const [, extractLinks] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await extractLinks.execute({
      url: 'https://example.com',
      filterText: 'doc',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.links).toHaveLength(1);
    expect(parsed.links[0].text).toBe('Documentation');
  });

  it('rejects blocked domains', async () => {
    const [, extractLinks] = createBrowserTools(
      { mode: 'basic', blockedDomains: ['evil.com'] },
      silentLogger,
    );
    const result = await extractLinks.execute({ url: 'https://evil.com/links' });

    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================================
// system.htmlToMarkdown
// ============================================================================

describe('system.htmlToMarkdown', () => {
  it('converts headings to markdown', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<h1>Title</h1><p>Content here</p>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('# Title');
    expect(parsed.markdown).toContain('Content here');
  });

  it('handles empty input', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({ html: '' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toBe('');
  });

  it('rejects missing html', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Missing or invalid html');
  });

  it('converts list items', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<ul><li>Item one</li><li>Item two</li></ul>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('- Item one');
    expect(parsed.markdown).toContain('- Item two');
  });

  it('converts code blocks', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<pre><code>const x = 1;</code></pre>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('```');
    expect(parsed.markdown).toContain('const x = 1;');
  });

  it('converts blockquotes', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<blockquote>Important note</blockquote>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('> Important note');
  });

  it('extracts page title', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<html><head><title>My Page</title></head><body></body></html>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('# My Page');
  });

  it('renders inline links as markdown', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<p>Visit <a href="https://example.com">Example</a> for more.</p>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('[Example](https://example.com)');
  });

  it('renders strong/bold as markdown', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<p>This is <strong>important</strong> text.</p>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('**important**');
  });

  it('renders emphasis/italic as markdown', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<p>This is <em>emphasized</em> text.</p>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('*emphasized*');
  });

  it('sanitizes javascript: links in inline markdown', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<p>Click <a href="javascript:alert(1)">here</a></p>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).not.toContain('javascript:');
    // Link text should still be present, just without the href
    expect(parsed.markdown).toContain('here');
  });

  it('preserves document order for mixed heading levels', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<h2>Second</h2><h1>First</h1><h3>Third</h3>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    const md = parsed.markdown;
    const secondIdx = md.indexOf('## Second');
    const firstIdx = md.indexOf('# First');
    const thirdIdx = md.indexOf('### Third');
    expect(secondIdx).toBeLessThan(firstIdx);
    expect(firstIdx).toBeLessThan(thirdIdx);
  });

  it('does not duplicate paragraphs nested inside blockquotes', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<blockquote><p>Quote text</p></blockquote><p>Standalone</p>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    // "Quote text" should appear exactly once (from blockquote), not twice
    const matches = parsed.markdown.match(/Quote text/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(parsed.markdown).toContain('> Quote text');
    expect(parsed.markdown).toContain('Standalone');
  });

  it('does not duplicate paragraphs nested inside list items', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<ul><li><p>List text</p></li></ul><p>After list</p>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    const matches = parsed.markdown.match(/List text/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(parsed.markdown).toContain('- List text');
    expect(parsed.markdown).toContain('After list');
  });

  it('handles single-quoted href in inline links', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: "<p>Visit <a href='https://example.com'>Example</a> here.</p>",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('[Example](https://example.com)');
  });

  it('numbers ordered list items', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<ol><li>First</li><li>Second</li><li>Third</li></ol>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('1. First');
    expect(parsed.markdown).toContain('2. Second');
    expect(parsed.markdown).toContain('3. Third');
  });

  it('distinguishes ordered and unordered lists', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<ul><li>Bullet</li></ul><ol><li>Number</li></ol>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('- Bullet');
    expect(parsed.markdown).toContain('1. Number');
  });

  it('converts simple table to markdown', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('| Name | Age |');
    expect(parsed.markdown).toContain('| --- | --- |');
    expect(parsed.markdown).toContain('| Alice | 30 |');
  });

  it('converts table with inline formatting', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<table><tr><th>Link</th></tr><tr><td><a href="https://x.com">X</a></td></tr></table>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('[X](https://x.com)');
  });

  it('pads table rows with empty cells', async () => {
    const [, , htmlToMd] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await htmlToMd.execute({
      html: '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td></td><td>3</td></tr></table>',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.markdown).toContain('| A | B | C |');
    expect(parsed.markdown).toContain('| 1 |  | 3 |');
  });
});

// ============================================================================
// sanitizeHref
// ============================================================================

describe('sanitizeHref', () => {
  it('allows http links', () => {
    expect(sanitizeHref('http://example.com')).toBe('http://example.com');
  });

  it('allows https links', () => {
    expect(sanitizeHref('https://example.com')).toBe('https://example.com');
  });

  it('allows mailto links', () => {
    expect(sanitizeHref('mailto:test@example.com')).toBe('mailto:test@example.com');
  });

  it('allows relative links', () => {
    expect(sanitizeHref('/about')).toBe('/about');
    expect(sanitizeHref('page.html')).toBe('page.html');
  });

  it('strips javascript: hrefs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBe('');
  });

  it('strips data: hrefs', () => {
    expect(sanitizeHref('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('strips vbscript: hrefs', () => {
    expect(sanitizeHref('vbscript:MsgBox("XSS")')).toBe('');
  });

  it('strips case-insensitive dangerous schemes', () => {
    expect(sanitizeHref('JAVASCRIPT:alert(1)')).toBe('');
    expect(sanitizeHref('JavaScript:void(0)')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeHref('')).toBe('');
  });

  it('strips control characters in scheme position', () => {
    expect(sanitizeHref('java\tscript:alert(1)')).toBe('');
    expect(sanitizeHref('java\nscript:alert(1)')).toBe('');
    expect(sanitizeHref('java\x00script:alert(1)')).toBe('');
  });

  it('strips file: scheme', () => {
    expect(sanitizeHref('file:///etc/passwd')).toBe('');
  });

  it('allows fragment-only links', () => {
    expect(sanitizeHref('#section')).toBe('#section');
  });
});

// ============================================================================
// Redirect handling
// ============================================================================

describe('redirect handling', () => {
  it('follows redirects', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'https://example.com/redirected' }),
      url: 'https://example.com/start',
      text: vi.fn().mockResolvedValue(''),
      body: null,
    } as unknown as Response);
    mockFetch.mockResolvedValueOnce(
      makeHtmlResponse('<html><body><p>Final</p></body></html>'),
    );

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://example.com/start' });

    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('redirect to blocked domain is stopped', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'https://evil.com/trap' }),
      url: 'https://safe.com/start',
      text: vi.fn().mockResolvedValue(''),
      body: null,
    } as unknown as Response);

    const [browse] = createBrowserTools(
      { mode: 'basic', blockedDomains: ['evil.com'] },
      silentLogger,
    );
    const result = await browse.execute({ url: 'https://safe.com/start' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('blocked');
  });

  it('stops after max redirects', async () => {
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ location: `https://example.com/r${i + 1}` }),
        url: `https://example.com/r${i}`,
        text: vi.fn().mockResolvedValue(''),
        body: null,
      } as unknown as Response);
    }

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://example.com/r0' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Too many redirects');
  });

  it('errors on redirect without Location header', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 301,
      statusText: 'Moved Permanently',
      headers: new Headers({}),
      url: 'https://example.com/old',
      text: vi.fn().mockResolvedValue(''),
      body: null,
    } as unknown as Response);

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://example.com/old' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Location header');
  });
});

// ============================================================================
// Domain validation
// ============================================================================

describe('domain validation', () => {
  it('respects allowed domains', async () => {
    const [browse] = createBrowserTools(
      { mode: 'basic', allowedDomains: ['api.example.com'] },
      silentLogger,
    );
    const result = await browse.execute({ url: 'https://other.com/page' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('not in allowed list');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks SSRF targets', async () => {
    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'http://localhost:3000/api' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('blocked');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks non-HTTP schemes', async () => {
    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'ftp://files.example.com/data' });

    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// Advanced: system.screenshot
// ============================================================================

describe('system.screenshot', () => {
  it('captures a screenshot', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const screenshot = tools.find((t) => t.name === 'system.screenshot')!;

    const result = await screenshot.execute({ url: 'https://example.com' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.image).toContain('data:image/png;base64,');
    expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(mockPage.screenshot).toHaveBeenCalled();
  });

  it('sets custom viewport', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const screenshot = tools.find((t) => t.name === 'system.screenshot')!;

    await screenshot.execute({ url: 'https://example.com', width: 800, height: 600 });

    expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 800, height: 600 });
  });

  it('supports fullPage option', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const screenshot = tools.find((t) => t.name === 'system.screenshot')!;

    await screenshot.execute({ url: 'https://example.com', fullPage: true });

    expect(mockPage.screenshot).toHaveBeenCalledWith({ fullPage: true });
  });

  it('rejects blocked domains', async () => {
    const tools = createBrowserTools(
      { mode: 'advanced', blockedDomains: ['evil.com'] },
      silentLogger,
    );
    const screenshot = tools.find((t) => t.name === 'system.screenshot')!;

    const result = await screenshot.execute({ url: 'https://evil.com' });
    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// Advanced: system.browserAction
// ============================================================================

describe('system.browserAction', () => {
  it('clicks an element', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'click',
      selector: '#submit-btn',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.action).toBe('click');
    expect(parsed.description).toContain('#submit-btn');
    expect(mockPage.click).toHaveBeenCalledWith('#submit-btn');
  });

  it('types text into element', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'type',
      selector: '#search',
      text: 'hello world',
    });

    expect(result.isError).toBeUndefined();
    expect(mockPage.fill).toHaveBeenCalledWith('#search', 'hello world');
  });

  it('scrolls the page', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'scroll',
      x: 0,
      y: 500,
    });

    expect(result.isError).toBeUndefined();
    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 500);
  });

  it('waits for selector', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'waitForSelector',
      selector: '.loaded',
      waitMs: 3000,
    });

    expect(result.isError).toBeUndefined();
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('.loaded', { timeout: 3000 });
  });

  it('returnScreenshot includes image', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'click',
      selector: '#btn',
      returnScreenshot: true,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.image).toContain('data:image/png;base64,');
  });

  it('rejects click without selector before opening page', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'click',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('selector is required');
    // Page should not have been opened
    expect(mockBrowser.newPage).not.toHaveBeenCalled();
  });

  it('rejects type without selector before opening page', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'type',
      text: 'hello',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('selector is required');
    expect(mockBrowser.newPage).not.toHaveBeenCalled();
  });

  it('rejects type without text before opening page', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'type',
      selector: '#input',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('text is required');
    expect(mockBrowser.newPage).not.toHaveBeenCalled();
  });

  it('rejects unknown action before opening page', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const action = tools.find((t) => t.name === 'system.browserAction')!;

    const result = await action.execute({
      url: 'https://example.com',
      action: 'destroy',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Unknown action');
    expect(mockBrowser.newPage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Advanced: system.evaluateJs
// ============================================================================

describe('system.evaluateJs', () => {
  it('evaluates JS and returns result', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const evalJs = tools.find((t) => t.name === 'system.evaluateJs')!;

    const result = await evalJs.execute({
      url: 'https://example.com',
      code: 'document.title',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.result).toBe('eval-result');
    expect(mockPage.evaluate).toHaveBeenCalledWith('document.title');
  });

  it('handles eval errors', async () => {
    mockPage.evaluate.mockRejectedValueOnce(new Error('ReferenceError: x is not defined'));

    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const evalJs = tools.find((t) => t.name === 'system.evaluateJs')!;

    const result = await evalJs.execute({
      url: 'https://example.com',
      code: 'x.y.z',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('JS evaluation failed');
  });

  it('rejects missing code', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const evalJs = tools.find((t) => t.name === 'system.evaluateJs')!;

    const result = await evalJs.execute({ url: 'https://example.com' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Missing or invalid code');
  });

  it('rejects empty code string', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const evalJs = tools.find((t) => t.name === 'system.evaluateJs')!;

    const result = await evalJs.execute({ url: 'https://example.com', code: '' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('Missing or invalid code');
  });

  it('rejects blocked domains', async () => {
    const tools = createBrowserTools(
      { mode: 'advanced', blockedDomains: ['evil.com'] },
      silentLogger,
    );
    const evalJs = tools.find((t) => t.name === 'system.evaluateJs')!;

    const result = await evalJs.execute({
      url: 'https://evil.com',
      code: 'document.cookie',
    });

    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// Advanced: system.exportPdf
// ============================================================================

describe('system.exportPdf', () => {
  it('generates a PDF', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const exportPdf = tools.find((t) => t.name === 'system.exportPdf')!;

    const result = await exportPdf.execute({ url: 'https://example.com' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.pdf).toContain('data:application/pdf;base64,');
  });

  it('supports landscape option', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const exportPdf = tools.find((t) => t.name === 'system.exportPdf')!;

    await exportPdf.execute({ url: 'https://example.com', landscape: true });

    expect(mockPage.pdf).toHaveBeenCalledWith(expect.objectContaining({ landscape: true }));
  });

  it('supports margin option', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const exportPdf = tools.find((t) => t.name === 'system.exportPdf')!;

    await exportPdf.execute({ url: 'https://example.com', margin: '1cm' });

    expect(mockPage.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
      }),
    );
  });

  it('rejects blocked domains', async () => {
    const tools = createBrowserTools(
      { mode: 'advanced', blockedDomains: ['evil.com'] },
      silentLogger,
    );
    const exportPdf = tools.find((t) => t.name === 'system.exportPdf')!;

    const result = await exportPdf.execute({ url: 'https://evil.com' });
    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// Sandbox flag stripping
// ============================================================================

describe('getBrowser sandbox protection', () => {
  it('strips --no-sandbox from launch args', async () => {
    const tools = createBrowserTools(
      { mode: 'advanced', launchOptions: { args: ['--no-sandbox', '--headless'] } },
      silentLogger,
    );
    const screenshot = tools.find((t) => t.name === 'system.screenshot')!;
    await screenshot.execute({ url: 'https://example.com' });

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--headless'],
      }),
    );
  });

  it('strips --disable-setuid-sandbox from launch args', async () => {
    const tools = createBrowserTools(
      { mode: 'advanced', launchOptions: { args: ['--disable-setuid-sandbox'] } },
      silentLogger,
    );
    const screenshot = tools.find((t) => t.name === 'system.screenshot')!;
    await screenshot.execute({ url: 'https://example.com' });

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [],
      }),
    );
  });
});

// ============================================================================
// closeBrowser
// ============================================================================

describe('closeBrowser', () => {
  it('closes the browser instance', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const screenshot = tools.find((t) => t.name === 'system.screenshot')!;
    await screenshot.execute({ url: 'https://example.com' });

    await closeBrowser();
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('is safe to call when no browser is running', async () => {
    await closeBrowser();
  });

  it('nulls the reference even if close() throws', async () => {
    const tools = createBrowserTools({ mode: 'advanced' }, silentLogger);
    const screenshot = tools.find((t) => t.name === 'system.screenshot')!;
    await screenshot.execute({ url: 'https://example.com' });

    mockBrowser.close.mockRejectedValueOnce(new Error('Browser crashed'));

    await expect(closeBrowser()).rejects.toThrow('Browser crashed');
    // A subsequent call should not try to close the dead browser again
    mockBrowser.close.mockClear();
    await closeBrowser(); // should be a no-op
    expect(mockBrowser.close).not.toHaveBeenCalled();
  });
});

// ============================================================================
// AbortError handling
// ============================================================================

describe('AbortError handling', () => {
  it('handles AbortError from fetch', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    const [browse] = createBrowserTools({ mode: 'basic' }, silentLogger);
    const result = await browse.execute({ url: 'https://example.com/abort' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain('timed out');
  });
});
