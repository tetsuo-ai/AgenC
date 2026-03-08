/**
 * Shared webhook route contracts and routing utilities for gateway-owned
 * ingress and channel plugin webhook registration.
 *
 * @module
 */

/** HTTP method for webhook routes. */
export type WebhookMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** A registered webhook route. */
export interface WebhookRoute {
  readonly method: WebhookMethod;
  readonly path: string;
  readonly handler: WebhookHandler;
}

/** Webhook request passed to handlers. */
export interface WebhookRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly query: Readonly<Record<string, string>>;
  readonly params?: Readonly<Record<string, string>>;
  readonly remoteAddress?: string;
}

/** Webhook response returned by handlers. */
export interface WebhookResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

/** Handler function for a webhook route. */
export type WebhookHandler = (
  req: WebhookRequest,
) => Promise<WebhookResponse>;

export interface WebhookRouteMatch {
  readonly route: WebhookRoute;
  readonly params: Readonly<Record<string, string>>;
}

interface CompiledWebhookRoute {
  readonly route: WebhookRoute;
  readonly segments: readonly string[];
}

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeadingSlash === "/") {
    return "/";
  }
  return withLeadingSlash.replace(/\/+$/, "");
}

function joinWebhookPath(prefix: string, suffix: string): string {
  const normalizedPrefix = normalizeWebhookPath(prefix);
  const normalizedSuffix = normalizeWebhookPath(suffix);
  if (normalizedSuffix === "/") {
    return normalizedPrefix;
  }
  return normalizeWebhookPath(
    `${normalizedPrefix}/${normalizedSuffix.replace(/^\/+/, "")}`,
  );
}

function splitWebhookPath(path: string): readonly string[] {
  const normalized = normalizeWebhookPath(path);
  if (normalized === "/") {
    return [];
  }
  return normalized.slice(1).split("/");
}

function buildExactRouteKey(method: string, path: string): string {
  return `${method} ${normalizeWebhookPath(path)}`;
}

function buildPatternRouteKey(method: string, path: string): string {
  const normalizedSegments = splitWebhookPath(path).map((segment) =>
    segment.startsWith(":") ? ":" : segment,
  );
  return `${method} /${normalizedSegments.join("/")}`;
}

function matchWebhookPath(
  patternSegments: readonly string[],
  actualPath: string,
): Record<string, string> | undefined {
  const actualSegments = splitWebhookPath(actualPath);
  if (patternSegments.length !== actualSegments.length) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index]!;
    const actualSegment = actualSegments[index]!;
    if (!patternSegment.startsWith(":")) {
      if (patternSegment !== actualSegment) {
        return undefined;
      }
      continue;
    }

    const paramName = patternSegment.slice(1).trim();
    if (!paramName) {
      return undefined;
    }
    params[paramName] = actualSegment;
  }

  return params;
}

export class WebhookRouteRegistry {
  private readonly exactRoutes = new Map<string, WebhookRoute>();
  private readonly patternRoutes = new Map<string, CompiledWebhookRoute>();
  private readonly insertionOrder: WebhookRoute[] = [];

  add(route: WebhookRoute): boolean {
    const normalizedRoute: WebhookRoute = {
      ...route,
      path: normalizeWebhookPath(route.path),
    };
    const segments = splitWebhookPath(normalizedRoute.path);
    const hasParams = segments.some((segment) => segment.startsWith(":"));

    if (!hasParams) {
      const exactKey = buildExactRouteKey(
        normalizedRoute.method,
        normalizedRoute.path,
      );
      if (this.exactRoutes.has(exactKey)) {
        return false;
      }
      this.exactRoutes.set(exactKey, normalizedRoute);
      this.insertionOrder.push(normalizedRoute);
      return true;
    }

    const patternKey = buildPatternRouteKey(
      normalizedRoute.method,
      normalizedRoute.path,
    );
    if (this.patternRoutes.has(patternKey)) {
      return false;
    }
    this.patternRoutes.set(patternKey, {
      route: normalizedRoute,
      segments,
    });
    this.insertionOrder.push(normalizedRoute);
    return true;
  }

  list(): ReadonlyArray<WebhookRoute> {
    return [...this.insertionOrder];
  }

  get routesInternal(): ReadonlyArray<WebhookRoute> {
    return this.insertionOrder;
  }

  match(method: string, path: string): WebhookRouteMatch | undefined {
    const normalizedPath = normalizeWebhookPath(path);
    const exactRoute = this.exactRoutes.get(
      buildExactRouteKey(method, normalizedPath),
    );
    if (exactRoute) {
      return {
        route: exactRoute,
        params: {},
      };
    }

    for (const compiled of this.patternRoutes.values()) {
      if (compiled.route.method !== method) {
        continue;
      }
      const params = matchWebhookPath(compiled.segments, normalizedPath);
      if (!params) {
        continue;
      }
      return {
        route: compiled.route,
        params,
      };
    }

    return undefined;
  }

  get size(): number {
    return this.insertionOrder.length;
  }
}

/**
 * Router for registering channel-scoped webhook endpoints.
 */
export class WebhookRouter {
  private readonly registry = new WebhookRouteRegistry();
  private readonly prefix: string;

  constructor(channelName: string) {
    this.prefix = `/webhooks/${channelName}`;
  }

  /** Register a route. Path is auto-prefixed with /webhooks/{channelName}. */
  route(method: WebhookMethod, path: string, handler: WebhookHandler): void {
    const route: WebhookRoute = {
      method,
      path: joinWebhookPath(this.prefix, path),
      handler,
    };
    if (!this.registry.add(route)) {
      throw new Error(
        `Webhook route "${route.method} ${route.path}" is already registered`,
      );
    }
  }

  /** Shorthand for POST routes (most common for webhooks). */
  post(path: string, handler: WebhookHandler): void {
    this.route("POST", path, handler);
  }

  /** Shorthand for GET routes (used for webhook verification). */
  get(path: string, handler: WebhookHandler): void {
    this.route("GET", path, handler);
  }

  /** All registered routes (returns a shallow copy). */
  get routes(): ReadonlyArray<WebhookRoute> {
    return this.registry.list();
  }

  /** @internal Route access for PluginCatalog aggregation (avoids copy). */
  get routesInternal(): ReadonlyArray<WebhookRoute> {
    return this.registry.routesInternal;
  }
}
