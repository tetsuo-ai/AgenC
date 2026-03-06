const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
export function resolveAllowedOrigin(origin) {
    if (!origin) {
        return undefined;
    }
    return LOOPBACK_ORIGIN_RE.test(origin) ? origin : undefined;
}
export function isAuthorizedRequest(authorizationHeader, authToken) {
    return authorizationHeader === `Bearer ${authToken}`;
}
