/**
 * Type declarations for privacycash package (optional dependency)
 * This package provides shielded transaction capabilities on Solana.
 */
declare module "privacycash" {
  import { Keypair, PublicKey } from "@solana/web3.js";

  export interface PrivacyCashConfig {
    RPC_url: string;
    owner: Keypair;
    enableDebug?: boolean;
  }

  export interface DepositParams {
    lamports: number;
  }

  export interface DepositResult {
    signature?: string;
  }

  export interface WithdrawParams {
    lamports: number;
    recipientAddress: string;
  }

  export interface BalanceResult {
    lamports: number;
  }

  export class PrivacyCash {
    publicKey: PublicKey;
    constructor(config: PrivacyCashConfig);
    deposit(params: DepositParams): Promise<DepositResult | undefined>;
    withdraw(params: WithdrawParams): Promise<unknown>;
    getPrivateBalance(): Promise<BalanceResult>;
  }
}
