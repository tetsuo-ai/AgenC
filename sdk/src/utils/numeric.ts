export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === "bigint") {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(-Number.MAX_SAFE_INTEGER)
    ) {
      throw new RangeError(
        `bigint ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be safely converted`,
      );
    }
    return Number(value);
  }
  return 0;
}

export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    const str = (value as { toString: () => string }).toString();
    try {
      return BigInt(str);
    } catch {
      throw new Error(`Cannot convert "${str}" to bigint`);
    }
  }
  return 0n;
}
