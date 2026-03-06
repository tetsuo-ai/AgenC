import { randomBytes } from "node:crypto";

export const DESKTOP_AUTH_ENV_KEY = "DESKTOP_AUTH_TOKEN";

export function createDesktopAuthToken(): string {
  return randomBytes(32).toString("hex");
}

export function createDesktopAuthHeaders(
  authToken: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  return {
    ...headers,
    Authorization: `Bearer ${authToken}`,
  };
}
