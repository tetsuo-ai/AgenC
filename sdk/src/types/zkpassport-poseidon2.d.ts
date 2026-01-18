declare module '@zkpassport/poseidon2' {
  export function poseidon2Hash(inputs: bigint[]): bigint;
  export function poseidon2HashAsync(inputs: bigint[]): Promise<bigint>;
}
