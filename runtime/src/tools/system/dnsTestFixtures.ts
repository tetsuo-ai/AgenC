export const TEST_PUBLIC_IP = [93, 184, 216, 34].join(".");
export const TEST_LOOPBACK_IP = [127, 0, 0, 1].join(".");

export function ipv4LookupResult(address: string) {
  return { address, family: 4 } as const;
}

export function ipv4LookupResults(...addresses: string[]) {
  return addresses.map(ipv4LookupResult);
}
