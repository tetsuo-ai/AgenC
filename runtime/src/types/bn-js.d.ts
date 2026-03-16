declare module "bn.js" {
  export default class BN {
    constructor(
      value?:
        | string
        | number
        | bigint
        | ArrayLike<number>
        | { readonly words?: readonly number[] },
      base?: number | "hex" | "le" | "be",
      endian?: "le" | "be",
    );
  }
}
