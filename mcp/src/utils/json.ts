export function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') {
      return `${item}n`;
    }
    return item;
  });
}

export function clone<T>(value: T): T {
  return JSON.parse(safeStringify(value)) as T;
}
