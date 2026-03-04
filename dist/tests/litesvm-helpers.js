"use strict";
/**
 * LiteSVM test helpers for AgenC integration tests.
 *
 * Replaces the anchor-test-validator approach with an in-process Solana VM
 * for ~10x faster test execution. Provides:
 * - createLiteSVMContext(): fully configured LiteSVM + Anchor provider + program
 * - fundAccount(): instant SOL funding (replaces requestAirdrop + confirmTransaction)
 * - getClockTimestamp() / advanceClock(): clock manipulation
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLiteSVMContext = createLiteSVMContext;
exports.fundAccount = fundAccount;
exports.getClockTimestamp = getClockTimestamp;
exports.advanceClock = advanceClock;
exports.injectMockVerifierRouter = injectMockVerifierRouter;
const anchor = __importStar(require("@coral-xyz/anchor"));
const anchor_1 = require("@coral-xyz/anchor");
const anchor_litesvm_1 = require("anchor-litesvm");
const web3_js_1 = require("@solana/web3.js");
const bs58 = __importStar(require("bs58"));
const path = __importStar(require("path"));
const BPF_LOADER_UPGRADEABLE_ID = new web3_js_1.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/**
 * Inject the BPF Loader Upgradeable ProgramData PDA.
 * Required because `initialize_protocol` validates the upgrade authority
 * via a remaining_accounts check on the ProgramData account.
 */
function setupProgramDataAccount(svm, programId, authority) {
    const [programDataPda] = web3_js_1.PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);
    // ProgramData layout:
    //   4 bytes: AccountType (3 = ProgramData, little-endian u32)
    //   8 bytes: slot (u64 LE)
    //   1 byte:  Option<Pubkey> tag (1 = Some)
    //   32 bytes: upgrade_authority pubkey
    const data = new Uint8Array(45);
    const view = new DataView(data.buffer);
    view.setUint32(0, 3, true); // AccountType::ProgramData
    view.setBigUint64(4, 0n, true); // slot = 0
    data[12] = 1; // Option::Some
    data.set(authority.toBytes(), 13); // upgrade_authority
    svm.setAccount(programDataPda, {
        lamports: 1000000000,
        data,
        owner: BPF_LOADER_UPGRADEABLE_ID,
        executable: false,
    });
}
/**
 * Extend the LiteSVM connection proxy with methods needed by tests
 * and @solana/spl-token helper functions.
 *
 * The base LiteSVMConnectionProxy only provides getAccountInfo,
 * getAccountInfoAndContext, and getMinimumBalanceForRentExemption.
 * We add: getBalance, getLatestBlockhash, sendTransaction,
 * confirmTransaction, requestAirdrop, getSlot, getBlockTime,
 * getTransaction, and getParsedTransaction.
 */
function extendConnectionProxy(svm, connection, walletRef) {
    // Save original getAccountInfo to wrap it
    const originalGetAccountInfo = connection.getAccountInfo.bind(connection);
    // Override getAccountInfo to return null instead of throwing for non-existent accounts.
    // This matches the real Connection behavior and is required by @solana/spl-token.
    connection.getAccountInfo = async (publicKey, commitmentOrConfig) => {
        const account = svm.getAccount(publicKey);
        if (!account)
            return null;
        return {
            ...account,
            data: Buffer.from(account.data),
        };
    };
    // Also override getAccountInfoAndContext for consistency
    connection.getAccountInfoAndContext = async (publicKey, commitmentOrConfig) => {
        const account = svm.getAccount(publicKey);
        if (!account) {
            return {
                context: { slot: Number(svm.getClock().slot) },
                value: null,
            };
        }
        return {
            context: { slot: Number(svm.getClock().slot) },
            value: {
                ...account,
                data: Buffer.from(account.data),
            },
        };
    };
    // getBalance — used ~48 times across tests for balance verification
    connection.getBalance = async (address, _commitment) => {
        const balance = svm.getBalance(address);
        return balance !== null ? Number(balance) : 0;
    };
    // getLatestBlockhash — needed by @solana/web3.js sendAndConfirmTransaction
    connection.getLatestBlockhash = async (_commitment) => ({
        blockhash: svm.latestBlockhash(),
        lastValidBlockHeight: 0,
    });
    // sendTransaction — needed by @solana/spl-token's helper functions
    // which call sendAndConfirmTransaction(connection, tx, signers)
    connection.sendTransaction = async (transaction, signersOrOptions, options) => {
        if ("version" in transaction) {
            // VersionedTransaction
            const signers = Array.isArray(signersOrOptions) ? signersOrOptions : [];
            signers.forEach((s) => transaction.sign([s]));
            const res = svm.sendTransaction(transaction);
            // Use constructor.name instead of instanceof to handle module boundary
            // mismatch between anchor-litesvm's bundled litesvm and project litesvm
            if (res.constructor.name === "FailedTransactionMetadata") {
                const failed = res;
                throw new web3_js_1.SendTransactionError({
                    action: "send",
                    signature: "unknown",
                    transactionMessage: failed.err().toString(),
                    logs: failed.meta().logs(),
                });
            }
            return bs58.encode(transaction.signatures[0]);
        }
        // Legacy Transaction
        const signers = Array.isArray(signersOrOptions) ? signersOrOptions : [];
        transaction.feePayer = transaction.feePayer || walletRef.publicKey;
        transaction.recentBlockhash = svm.latestBlockhash();
        if (signers.length > 0) {
            transaction.sign(...signers);
        }
        const res = svm.sendTransaction(transaction);
        if (res.constructor.name === "FailedTransactionMetadata") {
            const failed = res;
            const sigRaw = transaction.signature;
            const signature = sigRaw ? bs58.encode(sigRaw) : "unknown";
            throw new web3_js_1.SendTransactionError({
                action: "send",
                signature,
                transactionMessage: failed.err().toString(),
                logs: failed.meta().logs(),
            });
        }
        return bs58.encode(transaction.signature);
    };
    // confirmTransaction — no-op since LiteSVM is synchronous
    connection.confirmTransaction = async (_strategyOrSignature, _commitment) => ({
        context: { slot: Number(svm.getClock().slot) },
        value: { err: null },
    });
    // requestAirdrop — delegates to svm.airdrop(), returns a dummy signature
    connection.requestAirdrop = async (address, lamports) => {
        svm.airdrop(address, BigInt(lamports));
        return "litesvm-airdrop-" + address.toBase58().slice(0, 8);
    };
    // getSlot — used by test_1.ts for timestamp-related tests
    connection.getSlot = async (_commitment) => {
        return Number(svm.getClock().slot);
    };
    // getBlockTime — used by test_1.ts for timestamp checks
    connection.getBlockTime = async (_slot) => {
        return Number(svm.getClock().unixTimestamp);
    };
    // getTransaction — used by test_1.ts for fee verification (~7 calls).
    // Returns a simplified object matching the fields tests actually check.
    connection.getTransaction = async (signature, _opts) => {
        let sigBytes;
        try {
            sigBytes = bs58.decode(signature);
        }
        catch {
            return null;
        }
        const meta = svm.getTransaction(sigBytes);
        if (!meta)
            return null;
        // LiteSVM's TransactionMetadata doesn't expose fee directly.
        // Standard Solana base fee is 5000 lamports per signature.
        const BASE_FEE = 5000;
        if (meta.constructor.name === "FailedTransactionMetadata") {
            const failed = meta;
            return {
                meta: {
                    fee: BASE_FEE,
                    err: failed.err().toString(),
                },
            };
        }
        return {
            meta: {
                fee: BASE_FEE,
                err: null,
            },
        };
    };
    // getParsedTransaction — some test patterns may use this
    connection.getParsedTransaction = connection.getTransaction;
    // getSignatureStatus — no-op, everything is confirmed
    connection.getSignatureStatuses = async (_signatures, _config) => ({
        context: { slot: Number(svm.getClock().slot) },
        value: _signatures.map(() => ({
            slot: Number(svm.getClock().slot),
            confirmations: 1,
            err: null,
            confirmationStatus: "confirmed",
        })),
    });
}
/**
 * Create a fully configured LiteSVM test context.
 *
 * Loads the program from the workspace (target/deploy/*.so),
 * sets up the ProgramData PDA for initialize_protocol,
 * creates a funded payer wallet, and returns everything needed for tests.
 *
 * @param opts.splTokens - If true, loads SPL Token, Token-2022, and ATA programs
 */
function createLiteSVMContext(opts) {
    // Load the program from Anchor.toml + target/deploy/
    const svm = (0, anchor_litesvm_1.fromWorkspace)(".");
    // Add SPL token programs if requested
    if (opts?.splTokens) {
        svm.withDefaultPrograms();
    }
    // Enable transaction history for getTransaction() support
    svm.withTransactionHistory(10000n);
    // Set initial clock to a realistic timestamp so on-chain time checks work
    // (LiteSVM defaults to unix_timestamp=0 which breaks cooldowns and deadlines)
    const clock = svm.getClock();
    clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000));
    clock.slot = 1000n;
    svm.setClock(clock);
    // Create and fund the payer keypair
    const payer = web3_js_1.Keypair.generate();
    svm.airdrop(payer.publicKey, BigInt(1000 * web3_js_1.LAMPORTS_PER_SOL));
    // Create Anchor-compatible provider
    const wallet = new anchor.Wallet(payer);
    const provider = new anchor_litesvm_1.LiteSVMProvider(svm, wallet);
    // Extend the connection proxy with missing methods
    extendConnectionProxy(svm, provider.connection, wallet);
    // Load IDL and create typed Program instance
    const idl = require("../target/idl/agenc_coordination.json");
    const program = new anchor_1.Program(idl, provider);
    // Inject BPF Loader Upgradeable ProgramData PDA
    // (required for initialize_protocol's upgrade authority check)
    setupProgramDataAccount(svm, program.programId, payer.publicKey);
    // Set global provider for Anchor
    anchor.setProvider(provider);
    return { svm, provider, program, payer };
}
/**
 * Fund an account instantly via LiteSVM airdrop.
 * Replaces the requestAirdrop + confirmTransaction pattern.
 */
function fundAccount(svm, pubkey, lamports) {
    svm.airdrop(pubkey, BigInt(lamports));
}
/**
 * Get the current clock timestamp from LiteSVM.
 */
function getClockTimestamp(svm) {
    return Number(svm.getClock().unixTimestamp);
}
/**
 * Advance the LiteSVM clock by the specified number of seconds.
 * Also advances the slot proportionally (~2 slots per second).
 */
function advanceClock(svm, seconds) {
    const clock = svm.getClock();
    const newTimestamp = clock.unixTimestamp + BigInt(seconds);
    const newSlot = clock.slot + BigInt(seconds * 2);
    clock.unixTimestamp = newTimestamp;
    clock.slot = newSlot;
    svm.setClock(clock);
    // Expire the current blockhash so subsequent transactions get a fresh one.
    // Without this, two identical transactions (same accounts, instruction, signers)
    // sent before and after a clock advance would share the same blockhash,
    // producing identical bytes and triggering AlreadyProcessed (error 6).
    svm.expireBlockhash();
}
// ============================================================================
// Mock Verifier Router for ZK integration tests
// ============================================================================
const TRUSTED_RISC0_ROUTER_PROGRAM_ID = new web3_js_1.PublicKey("6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7");
const TRUSTED_RISC0_VERIFIER_PROGRAM_ID = new web3_js_1.PublicKey("THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge");
const TRUSTED_RISC0_SELECTOR = Uint8Array.from([0x52, 0x5a, 0x56, 0x4d]);
const VERIFIER_ENTRY_DISCRIMINATOR = Uint8Array.from([
    102, 247, 148, 158, 33, 153, 100, 93,
]);
/**
 * Inject a mock Verifier Router into LiteSVM for ZK integration tests.
 *
 * Loads a no-op BPF program at both the trusted Router and Verifier program IDs,
 * then injects the router PDA and verifier-entry PDA with correct data layouts.
 * The mock router accepts any CPI call (returns Ok), allowing positive-path
 * testing of complete_task_private without a real RISC Zero prover.
 */
function injectMockVerifierRouter(svm) {
    const mockSoPath = path.resolve(__dirname, "fixtures", "mock_verifier_router.so");
    // Load mock program at both trusted program IDs
    svm.addProgramFromFile(TRUSTED_RISC0_ROUTER_PROGRAM_ID, mockSoPath);
    svm.addProgramFromFile(TRUSTED_RISC0_VERIFIER_PROGRAM_ID, mockSoPath);
    // Inject router PDA: seeds=["router"] under router program
    const [routerPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("router")], TRUSTED_RISC0_ROUTER_PROGRAM_ID);
    svm.setAccount(routerPda, {
        lamports: 1000000,
        data: new Uint8Array(0),
        owner: TRUSTED_RISC0_ROUTER_PROGRAM_ID,
        executable: false,
    });
    // Inject verifier-entry PDA: seeds=["verifier", selector] under router program
    // Data layout (45 bytes):
    //   [0..8]   discriminator
    //   [8..12]  selector (RISC0_SELECTOR_LEN)
    //   [12..44] verifier pubkey (32 bytes)
    //   [44]     estopped flag (1 byte, 0 = not estopped)
    const [verifierEntryPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("verifier"), Buffer.from(TRUSTED_RISC0_SELECTOR)], TRUSTED_RISC0_ROUTER_PROGRAM_ID);
    const verifierEntryData = new Uint8Array(45);
    verifierEntryData.set(VERIFIER_ENTRY_DISCRIMINATOR, 0);
    verifierEntryData.set(TRUSTED_RISC0_SELECTOR, 8);
    verifierEntryData.set(TRUSTED_RISC0_VERIFIER_PROGRAM_ID.toBytes(), 12);
    verifierEntryData[44] = 0; // not estopped
    svm.setAccount(verifierEntryPda, {
        lamports: 1000000,
        data: verifierEntryData,
        owner: TRUSTED_RISC0_ROUTER_PROGRAM_ID,
        executable: false,
    });
}
