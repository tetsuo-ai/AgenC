const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

export function resolveAllowedOrigin(origin: string | undefined): string | undefined {
  if (!origin) {
    return undefined;
  }
  return LOOPBACK_ORIGIN_RE.test(origin) ? origin : undefined;
}

export function isAuthorizedRequest(
  authorizationHeader: string | undefined,
  authToken: string,
): boolean {
  return authorizationHeader === `Bearer ${authToken}`;
}
