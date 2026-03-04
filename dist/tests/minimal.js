"use strict";
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
describe("minimal-test", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
        .AgencCoordination;
    it("debugs registerAgent", async () => {
        // Print program info
        console.log("Program ID:", program.programId.toString());
        // Print IDL instruction info
        const registerAgentIx = program.idl.instructions.find((ix) => ix.name === "registerAgent" || ix.name === "register_agent");
        console.log("registerAgent instruction:", JSON.stringify(registerAgentIx, null, 2));
        // Generate test data
        const worker = web3_js_1.Keypair.generate();
        const agentId = Buffer.from("minimal-test-agent-001".padEnd(32, "\0"));
        // Derive PDA
        const [agentPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], program.programId);
        const [protocolPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("protocol")], program.programId);
        console.log("Agent PDA:", agentPda.toString());
        console.log("Protocol PDA:", protocolPda.toString());
        console.log("Worker:", worker.publicKey.toString());
        // Airdrop
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(worker.publicKey, 2 * web3_js_1.LAMPORTS_PER_SOL), "confirmed");
        // Try to register
        console.log("Calling registerAgent...");
        try {
            const tx = await program.methods
                .registerAgent(Array.from(agentId), new bn_js_1.default(1), "https://test.example.com", null, new bn_js_1.default(1 * web3_js_1.LAMPORTS_PER_SOL))
                .accounts({
                agent: agentPda,
                protocolConfig: protocolPda,
                authority: worker.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([worker])
                .rpc();
            console.log("TX:", tx);
        }
        catch (e) {
            console.error("Error:", e);
        }
    });
});
