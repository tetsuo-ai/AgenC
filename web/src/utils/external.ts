const ALLOWED_EXPLORER_HOSTS = new Set(["explorer.solana.com"]);

export function sanitizeExplorerUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      return "";
    }
    if (!ALLOWED_EXPLORER_HOSTS.has(parsed.hostname)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function openExternalUrl(raw: string): void {
  if (typeof window === "undefined") return;
  if (!raw) return;
  window.open(raw, "_blank", "noopener,noreferrer");
}
