/**
 * Shared helpers for filtering Anchor enum-style account status objects.
 */

export function matchesStatusFilter(
  status: unknown,
  statusFilter: string,
): boolean {
  if (typeof status !== "object" || status === null) {
    return false;
  }
  return Object.keys(status as Record<string, unknown>).some(
    (key) => key === statusFilter,
  );
}

export function filterAccountsByStatus<T>(
  accounts: readonly T[],
  statusFilter: string | undefined,
  getStatus: (account: T) => unknown,
): T[] {
  if (!statusFilter) {
    return [...accounts];
  }
  return accounts.filter((account) =>
    matchesStatusFilter(getStatus(account), statusFilter),
  );
}

export function formatEmptyStatusResult(
  entityPlural: string,
  statusFilter?: string,
): string {
  return statusFilter
    ? `No ${entityPlural} found with status: ${statusFilter}`
    : `No ${entityPlural} found`;
}
