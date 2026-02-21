/**
 * Cross-protocol bridge adapters.
 *
 * Provides adapters connecting AgenC's tool/skill system to external
 * ecosystems: LangChain, x402 micropayments, and Farcaster social.
 *
 * @module
 */

export type {
  LangChainTool,
  LangChainBridgeConfig,
  X402PaymentRequest,
  X402PaymentResponse,
  X402BridgeConfig,
  FarcasterPostParams,
  FarcasterPostResult,
  FarcasterBridgeConfig,
} from "./types.js";

export { BridgeError, BridgePaymentError } from "./errors.js";
export { LangChainBridge } from "./langchain.js";
export { X402Bridge } from "./x402.js";
export { FarcasterBridge } from "./farcaster.js";
