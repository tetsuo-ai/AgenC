"use strict";
/**
 * Minimal debug test to diagnose websocket/connection issues
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const anchor = __importStar(require("@coral-xyz/anchor"));
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
const test_utils_1 = require("./test-utils");
describe("minimal-debug", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    const [protocolPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol")], program.programId);
    it("should connect to provider", async () => {
        console.log("Provider endpoint:", provider.connection.rpcEndpoint);
        console.log("Program ID:", program.programId.toBase58());
        const slot = await provider.connection.getSlot();
        console.log("Current slot:", slot);
        const balance = await provider.connection.getBalance(provider.wallet.publicKey);
        console.log("Wallet balance:", balance / web3_js_1.LAMPORTS_PER_SOL, "SOL");
        console.log("Protocol PDA:", protocolPda.toBase58());
        const info = await provider.connection.getAccountInfo(protocolPda);
        console.log("Protocol exists:", info !== null);
        console.log("Connection test passed!");
    });
    it("should initialize protocol", async () => {
        const treasury = web3_js_1.Keypair.generate();
        const secondSigner = web3_js_1.Keypair.generate();
        const thirdSigner = web3_js_1.Keypair.generate();
        console.log("Treasury:", treasury.publicKey.toBase58());
        console.log("SecondSigner:", secondSigner.publicKey.toBase58());
        console.log("ThirdSigner:", thirdSigner.publicKey.toBase58());
        // Airdrop to treasury, secondSigner, and thirdSigner
        const airdropSig1 = await provider.connection.requestAirdrop(treasury.publicKey, web3_js_1.LAMPORTS_PER_SOL);
        const airdropSig2 = await provider.connection.requestAirdrop(secondSigner.publicKey, web3_js_1.LAMPORTS_PER_SOL);
        const airdropSig3 = await provider.connection.requestAirdrop(thirdSigner.publicKey, web3_js_1.LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(airdropSig1, "confirmed");
        await provider.connection.confirmTransaction(airdropSig2, "confirmed");
        await provider.connection.confirmTransaction(airdropSig3, "confirmed");
        console.log("Treasury, secondSigner, and thirdSigner funded");
        try {
            console.log("Calling initializeProtocol...");
            // Protocol initialization requires (fix #556):
            // - min_stake >= 0.001 SOL (1_000_000 lamports)
            // - min_stake_for_dispute > 0
            // - second_signer different from authority
            // - both authority and second_signer in multisig_owners
            // - threshold >= 2 and threshold < multisig_owners.length
            const minStake = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100); // 0.01 SOL
            const minStakeForDispute = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100); // 0.01 SOL
            const programDataPda = (0, test_utils_1.deriveProgramDataPda)(program.programId);
            const tx = await program.methods
                .initializeProtocol(51, // dispute_threshold
            100, // protocol_fee_bps
            minStake, // min_stake
            minStakeForDispute, // min_stake_for_dispute (new arg)
            2, // multisig_threshold (must be >= 2 and < owners.length)
            [provider.wallet.publicKey, secondSigner.publicKey, thirdSigner.publicKey])
                .accountsPartial({
                protocolConfig: protocolPda,
                treasury: secondSigner.publicKey,
                authority: provider.wallet.publicKey,
                secondSigner: secondSigner.publicKey, // new account (fix #556)
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .remainingAccounts([
                {
                    pubkey: (0, test_utils_1.deriveProgramDataPda)(program.programId),
                    isSigner: false,
                    isWritable: false,
                },
                {
                    pubkey: thirdSigner.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
            ])
                .signers([secondSigner, thirdSigner])
                .rpc();
            console.log("Transaction signature:", tx);
            console.log("Protocol initialized successfully!");
        }
        catch (e) {
            console.error("Error during initializeProtocol:");
            console.error("  Message:", e.message);
            if (e.logs) {
                console.error("  Logs:");
                e.logs.forEach((log) => console.error("    ", log));
            }
            if (e?.message?.includes("already in use") ||
                e?.message?.includes("ProtocolAlreadyInitialized")) {
                console.log("Protocol already initialized, continuing with existing config");
            }
            else {
                throw e;
            }
        }
        // Verify it was created
        const config = await program.account.protocolConfig.fetch(protocolPda);
        console.log("Protocol config fetched:");
        console.log("  Authority:", config.authority.toBase58());
        console.log("  Treasury:", config.treasury.toBase58());
        console.log("  Protocol fee:", config.protocolFeeBps);
    });
});
