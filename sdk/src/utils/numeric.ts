export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (value && typeof value === 'object' && 'toString' in value) {
    return BigInt((value as { toString: () => string }).toString());
  }
  return 0n;
}
