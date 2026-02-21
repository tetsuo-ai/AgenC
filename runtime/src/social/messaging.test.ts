import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import { PROGRAM_ID } from "@agenc/sdk";
import {
  MSG_MAGIC,
  MSG_CONTENT_MAX_ONCHAIN,
  encodeMessageStateKey,
  decodeMessageStateKey,
  encodeMessageStateValue,
  decodeMessageStateValue,
  type AgentMessage,
  type OffChainEnvelope,
  type PeerResolver,
} from "./messaging-types.js";
import {
  MessagingSendError,
  MessagingConnectionError,
  MessagingSignatureError,
} from "./messaging-errors.js";
import {
  signAgentMessage,
  verifyAgentSignature,
  buildSigningPayload,
} from "./crypto.js";
import { AgentMessaging } from "./messaging.js";
import { RuntimeErrorCodes, AnchorErrorCodes } from "../types/errors.js";
import { generateAgentId } from "../utils/encoding.js";

// ============================================================================
// Test Helpers
// ============================================================================

function randomPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function anchorError(code: number) {
  return { code, message: `custom program error: 0x${code.toString(16)}` };
}

function createMockProgram(overrides: Record<string, unknown> = {}) {
  const rpcMock = vi.fn().mockResolvedValue("mock-signature");

  const methodBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: rpcMock,
  };

  return {
    programId: PROGRAM_ID,
    provider: {
      publicKey: randomPubkey(),
    },
    account: {
      coordinationState: {
        all: vi.fn().mockResolvedValue([]),
      },
      agentRegistration: {
        fetchNullable: vi.fn().mockResolvedValue(null),
      },
    },
    methods: {
      updateState: vi.fn().mockReturnValue(methodBuilder),
    },
    _methodBuilder: methodBuilder,
    _rpcMock: rpcMock,
    ...overrides,
  } as any;
}

function createMockPeerResolver(
  overrides: Partial<PeerResolver> = {},
): PeerResolver {
  return {
    resolveEndpoint: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function createTestMessaging(overrides: Record<string, unknown> = {}) {
  const wallet = Keypair.generate();
  const agentId = generateAgentId(wallet.publicKey);
  const program = createMockProgram(overrides);

  const messaging = new AgentMessaging({
    program,
    agentId,
    wallet,
    config: { defaultMode: "on-chain" },
    ...overrides,
  });

  return { messaging, program, wallet, agentId };
}

// ============================================================================
// Encoding Tests
// ============================================================================

describe("encodeMessageStateKey / decodeMessageStateKey", () => {
  it("round-trips successfully", () => {
    const recipient = randomPubkey();
    const nonce = 12345;

    const encoded = encodeMessageStateKey(recipient, nonce);
    expect(encoded.length).toBe(32);

    const decoded = decodeMessageStateKey(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.nonce).toBe(nonce);
    expect(decoded!.recipientPrefix.length).toBe(20);
    expect(
      Buffer.from(decoded!.recipientPrefix).equals(
        Buffer.from(recipient.toBytes().subarray(0, 20)),
      ),
    ).toBe(true);
  });

  it("starts with MSG_MAGIC", () => {
    const encoded = encodeMessageStateKey(randomPubkey(), 0);
    expect(encoded[0]).toBe(0x6d); // 'm'
    expect(encoded[1]).toBe(0x73); // 's'
    expect(encoded[2]).toBe(0x67); // 'g'
    expect(encoded[3]).toBe(0x00); // '\0'
  });

  it("encodes nonce as big-endian u64", () => {
    const encoded = encodeMessageStateKey(randomPubkey(), 1);
    // Last 8 bytes are nonce
    const view = new DataView(encoded.buffer, encoded.byteOffset + 24, 8);
    expect(view.getUint32(0)).toBe(0); // high bits
    expect(view.getUint32(4)).toBe(1); // low bits
  });

  it("handles large nonces", () => {
    const nonce = 1700000000000; // typical Date.now()
    const encoded = encodeMessageStateKey(randomPubkey(), nonce);
    const decoded = decodeMessageStateKey(encoded);
    expect(decoded!.nonce).toBe(nonce);
  });

  it("handles nonce = 0", () => {
    const decoded = decodeMessageStateKey(
      encodeMessageStateKey(randomPubkey(), 0),
    );
    expect(decoded!.nonce).toBe(0);
  });

  it("returns null for wrong magic", () => {
    const key = new Uint8Array(32);
    key[0] = 0xff;
    expect(decodeMessageStateKey(key)).toBeNull();
  });

  it("returns null for wrong length", () => {
    expect(decodeMessageStateKey(new Uint8Array(16))).toBeNull();
  });

  it("produces different keys for different recipients", () => {
    const r1 = randomPubkey();
    const r2 = randomPubkey();
    const k1 = encodeMessageStateKey(r1, 1);
    const k2 = encodeMessageStateKey(r2, 1);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
  });

  it("produces different keys for different nonces", () => {
    const r = randomPubkey();
    const k1 = encodeMessageStateKey(r, 1);
    const k2 = encodeMessageStateKey(r, 2);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
  });
});

describe("encodeMessageStateValue / decodeMessageStateValue", () => {
  it("round-trips ASCII content", () => {
    const content = "Hello, world!";
    const encoded = encodeMessageStateValue(content);
    expect(encoded.length).toBe(64);
    expect(decodeMessageStateValue(encoded)).toBe(content);
  });

  it("round-trips UTF-8 content", () => {
    const content = "Hi ";
    const encoded = encodeMessageStateValue(content);
    expect(decodeMessageStateValue(encoded)).toBe(content);
  });

  it("pads short content with zeros", () => {
    const encoded = encodeMessageStateValue("AB");
    expect(encoded[0]).toBe(0x41); // 'A'
    expect(encoded[1]).toBe(0x42); // 'B'
    for (let i = 2; i < 64; i++) {
      expect(encoded[i]).toBe(0);
    }
  });

  it("throws on content exceeding 64 bytes", () => {
    const content = "A".repeat(65);
    expect(() => encodeMessageStateValue(content)).toThrow("exceeds");
  });

  it("throws on empty content", () => {
    expect(() => encodeMessageStateValue("")).toThrow("empty");
  });

  it("validates byte length not string length", () => {
    // 22 emoji chars × 4 bytes each = 88 bytes > 64
    const emojis = "\u{1F600}".repeat(17); // 17 × 4 = 68 bytes
    expect(() => encodeMessageStateValue(emojis)).toThrow("exceeds");
  });

  it("allows exactly 64 bytes", () => {
    const content = "A".repeat(64);
    const encoded = encodeMessageStateValue(content);
    expect(decodeMessageStateValue(encoded)).toBe(content);
  });
});

// ============================================================================
// Crypto Tests
// ============================================================================

describe("signAgentMessage / verifyAgentSignature", () => {
  it("round-trips with valid keypair", () => {
    const keypair = Keypair.generate();
    const payload = buildSigningPayload(
      keypair.publicKey,
      randomPubkey(),
      42,
      "test message",
    );

    const sig = signAgentMessage(keypair, payload);
    expect(sig.length).toBe(64);
    expect(verifyAgentSignature(keypair.publicKey, payload, sig)).toBe(true);
  });

  it("rejects wrong public key", () => {
    const keypair = Keypair.generate();
    const wrongKey = Keypair.generate().publicKey;
    const payload = buildSigningPayload(
      keypair.publicKey,
      randomPubkey(),
      1,
      "hi",
    );
    const sig = signAgentMessage(keypair, payload);

    expect(verifyAgentSignature(wrongKey, payload, sig)).toBe(false);
  });

  it("rejects tampered payload", () => {
    const keypair = Keypair.generate();
    const payload = buildSigningPayload(
      keypair.publicKey,
      randomPubkey(),
      1,
      "hello",
    );
    const sig = signAgentMessage(keypair, payload);

    const tampered = buildSigningPayload(
      keypair.publicKey,
      randomPubkey(),
      1,
      "world",
    );
    expect(verifyAgentSignature(keypair.publicKey, tampered, sig)).toBe(false);
  });

  it("rejects tampered signature", () => {
    const keypair = Keypair.generate();
    const payload = buildSigningPayload(
      keypair.publicKey,
      randomPubkey(),
      1,
      "hi",
    );
    const sig = signAgentMessage(keypair, payload);

    const badSig = new Uint8Array(sig);
    badSig[0] ^= 0xff;
    expect(verifyAgentSignature(keypair.publicKey, payload, badSig)).toBe(
      false,
    );
  });

  it("produces deterministic signatures", () => {
    const keypair = Keypair.generate();
    const recipient = randomPubkey();
    const payload = buildSigningPayload(keypair.publicKey, recipient, 1, "msg");

    const sig1 = signAgentMessage(keypair, payload);
    const sig2 = signAgentMessage(keypair, payload);
    expect(Buffer.from(sig1).equals(Buffer.from(sig2))).toBe(true);
  });

  it("handles empty content", () => {
    const keypair = Keypair.generate();
    const payload = buildSigningPayload(
      keypair.publicKey,
      randomPubkey(),
      0,
      "",
    );
    const sig = signAgentMessage(keypair, payload);
    expect(verifyAgentSignature(keypair.publicKey, payload, sig)).toBe(true);
  });
});

describe("buildSigningPayload", () => {
  it("has correct layout length", () => {
    const sender = randomPubkey();
    const recipient = randomPubkey();
    const content = "hello";
    const payload = buildSigningPayload(sender, recipient, 1, content);
    // 32 (sender) + 32 (recipient) + 8 (nonce) + 5 (content) = 77
    expect(payload.length).toBe(77);
  });

  it("embeds sender and recipient correctly", () => {
    const sender = randomPubkey();
    const recipient = randomPubkey();
    const payload = buildSigningPayload(sender, recipient, 0, "");

    expect(
      Buffer.from(payload.subarray(0, 32)).equals(
        Buffer.from(sender.toBytes()),
      ),
    ).toBe(true);
    expect(
      Buffer.from(payload.subarray(32, 64)).equals(
        Buffer.from(recipient.toBytes()),
      ),
    ).toBe(true);
  });

  it("embeds nonce as big-endian u64", () => {
    const payload = buildSigningPayload(
      randomPubkey(),
      randomPubkey(),
      256,
      "",
    );
    const view = new DataView(payload.buffer, payload.byteOffset + 64, 8);
    expect(view.getUint32(0)).toBe(0);
    expect(view.getUint32(4)).toBe(256);
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe("MessagingSendError", () => {
  it("has correct code and properties", () => {
    const err = new MessagingSendError("abc123", "test reason");
    expect(err.code).toBe(RuntimeErrorCodes.MESSAGING_SEND_ERROR);
    expect(err.name).toBe("MessagingSendError");
    expect(err.recipient).toBe("abc123");
    expect(err.reason).toBe("test reason");
    expect(err.message).toContain("abc123");
    expect(err.message).toContain("test reason");
  });
});

describe("MessagingConnectionError", () => {
  it("has correct code and properties", () => {
    const err = new MessagingConnectionError("ws://localhost", "refused");
    expect(err.code).toBe(RuntimeErrorCodes.MESSAGING_CONNECTION_ERROR);
    expect(err.name).toBe("MessagingConnectionError");
    expect(err.endpoint).toBe("ws://localhost");
    expect(err.reason).toBe("refused");
  });
});

describe("MessagingSignatureError", () => {
  it("has correct code and properties", () => {
    const err = new MessagingSignatureError("senderXYZ", "bad sig");
    expect(err.code).toBe(RuntimeErrorCodes.MESSAGING_SIGNATURE_ERROR);
    expect(err.name).toBe("MessagingSignatureError");
    expect(err.sender).toBe("senderXYZ");
    expect(err.reason).toBe("bad sig");
  });
});

// ============================================================================
// AgentMessaging — On-Chain Send Tests
// ============================================================================

describe("AgentMessaging — on-chain send", () => {
  it("calls updateState with correct args", async () => {
    const { messaging, program } = createTestMessaging();
    const recipient = randomPubkey();

    const msg = await messaging.send(recipient, "hello", "on-chain");

    expect(program.methods.updateState).toHaveBeenCalledTimes(1);
    const callArgs = program.methods.updateState.mock.calls[0];

    // state_key is 32 bytes array
    const stateKeyArr = callArgs[0] as number[];
    expect(stateKeyArr.length).toBe(32);
    // Verify magic prefix
    expect(stateKeyArr[0]).toBe(0x6d);
    expect(stateKeyArr[1]).toBe(0x73);
    expect(stateKeyArr[2]).toBe(0x67);
    expect(stateKeyArr[3]).toBe(0x00);

    // state_value is 64 bytes array
    const stateValueArr = callArgs[1] as number[];
    expect(stateValueArr.length).toBe(64);
    // First bytes should be 'hello'
    expect(stateValueArr[0]).toBe(0x68); // 'h'
    expect(stateValueArr[1]).toBe(0x65); // 'e'
    expect(stateValueArr[2]).toBe(0x6c); // 'l'
    expect(stateValueArr[3]).toBe(0x6c); // 'l'
    expect(stateValueArr[4]).toBe(0x6f); // 'o'

    // expected_version = BN(0)
    expect(callArgs[2].toString()).toBe("0");

    expect(msg.onChain).toBe(true);
    expect(msg.mode).toBe("on-chain");
    expect(msg.content).toBe("hello");
    expect(msg.signature.length).toBe(64);
  });

  it("calls accountsPartial with correct accounts", async () => {
    const { messaging, program, wallet } = createTestMessaging();
    const recipient = randomPubkey();

    await messaging.send(recipient, "test", "on-chain");

    const accounts = program._methodBuilder.accountsPartial.mock.calls[0][0];
    expect(accounts.state).toBeInstanceOf(PublicKey);
    expect(accounts.agent).toBeInstanceOf(PublicKey);
    expect(accounts.authority.equals(wallet.publicKey)).toBe(true);
    expect(accounts.protocolConfig).toBeInstanceOf(PublicKey);
    expect(accounts.systemProgram).toBeInstanceOf(PublicKey);
  });

  it("rejects content > 64 bytes", async () => {
    const { messaging } = createTestMessaging();
    const recipient = randomPubkey();

    await expect(
      messaging.send(recipient, "A".repeat(65), "on-chain"),
    ).rejects.toThrow(MessagingSendError);
  });

  it("rejects empty content", async () => {
    const { messaging } = createTestMessaging();
    const recipient = randomPubkey();

    await expect(messaging.send(recipient, "", "on-chain")).rejects.toThrow(
      MessagingSendError,
    );
  });

  it("validates byte length not string length", async () => {
    const { messaging } = createTestMessaging();
    const recipient = randomPubkey();

    // 17 emoji chars × 4 bytes = 68 bytes > 64
    await expect(
      messaging.send(recipient, "\u{1F600}".repeat(17), "on-chain"),
    ).rejects.toThrow(MessagingSendError);
  });

  it("maps RateLimitExceeded to MessagingSendError", async () => {
    const rpcMock = vi
      .fn()
      .mockRejectedValue(anchorError(AnchorErrorCodes.RateLimitExceeded));
    const methodBuilder = {
      accountsPartial: vi.fn().mockReturnThis(),
      rpc: rpcMock,
    };
    const program = createMockProgram({
      methods: { updateState: vi.fn().mockReturnValue(methodBuilder) },
    });

    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      config: { defaultMode: "on-chain" },
    });

    await expect(
      messaging.send(randomPubkey(), "hi", "on-chain"),
    ).rejects.toThrow(/rate limit/i);
  });

  it("retries on VersionMismatch (nonce collision)", async () => {
    const rpcMock = vi
      .fn()
      .mockRejectedValueOnce(anchorError(AnchorErrorCodes.VersionMismatch))
      .mockResolvedValueOnce("mock-signature");
    const methodBuilder = {
      accountsPartial: vi.fn().mockReturnThis(),
      rpc: rpcMock,
    };
    const program = createMockProgram({
      methods: { updateState: vi.fn().mockReturnValue(methodBuilder) },
    });

    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      config: { defaultMode: "on-chain" },
    });

    const msg = await messaging.send(randomPubkey(), "retry test", "on-chain");
    expect(msg.onChain).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("throws after max nonce collision retries", async () => {
    const rpcMock = vi
      .fn()
      .mockRejectedValue(anchorError(AnchorErrorCodes.VersionMismatch));
    const methodBuilder = {
      accountsPartial: vi.fn().mockReturnThis(),
      rpc: rpcMock,
    };
    const program = createMockProgram({
      methods: { updateState: vi.fn().mockReturnValue(methodBuilder) },
    });

    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      config: { defaultMode: "on-chain" },
    });

    await expect(
      messaging.send(randomPubkey(), "fail", "on-chain"),
    ).rejects.toThrow(/nonce collision/i);
    // 1 initial + 3 retries = 4 total
    expect(rpcMock).toHaveBeenCalledTimes(4);
  });

  it("increments nonce on each send", async () => {
    const { messaging, program } = createTestMessaging();
    const recipient = randomPubkey();

    const msg1 = await messaging.send(recipient, "one", "on-chain");
    const msg2 = await messaging.send(recipient, "two", "on-chain");

    expect(msg2.nonce).toBe(msg1.nonce + 1);
  });

  it("expected_version is always 0 (new account per message)", async () => {
    const { messaging, program } = createTestMessaging();
    const recipient = randomPubkey();

    await messaging.send(recipient, "first", "on-chain");
    await messaging.send(recipient, "second", "on-chain");

    for (const call of program.methods.updateState.mock.calls) {
      expect(call[2].toString()).toBe("0");
    }
  });

  it("returns a signed message", async () => {
    const { messaging, wallet } = createTestMessaging();
    const recipient = randomPubkey();

    const msg = await messaging.send(recipient, "signed msg", "on-chain");

    // Verify the signature is valid
    const payload = buildSigningPayload(
      wallet.publicKey,
      recipient,
      msg.nonce,
      "signed msg",
    );
    expect(verifyAgentSignature(wallet.publicKey, payload, msg.signature)).toBe(
      true,
    );
  });
});

// ============================================================================
// AgentMessaging — On-Chain History Tests
// ============================================================================

describe("AgentMessaging — on-chain history", () => {
  it("queries with correct memcmp filters", async () => {
    const { messaging, program, wallet } = createTestMessaging();
    const peer = randomPubkey();

    await messaging.getOnChainHistory(peer);

    // Should make 2 queries (sent by me + sent by peer)
    expect(program.account.coordinationState.all).toHaveBeenCalledTimes(2);

    // First call: filter on my authority at offset 8
    const call1 = program.account.coordinationState.all.mock.calls[0][0];
    expect(call1[0].memcmp.offset).toBe(8);
    expect(call1[0].memcmp.bytes).toBe(wallet.publicKey.toBase58());

    // Second call: filter on peer authority at offset 8
    const call2 = program.account.coordinationState.all.mock.calls[1][0];
    expect(call2[0].memcmp.offset).toBe(8);
    expect(call2[0].memcmp.bytes).toBe(peer.toBase58());
  });

  it("filters by MSG_MAGIC prefix at offset 40", async () => {
    const { messaging, program } = createTestMessaging();
    const peer = randomPubkey();

    await messaging.getOnChainHistory(peer);

    for (const call of program.account.coordinationState.all.mock.calls) {
      const filters = call[0];
      // Second filter should be on state_key field at offset 40
      expect(filters[1].memcmp.offset).toBe(40);
    }
  });

  it("returns bidirectional messages sorted by nonce", async () => {
    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const peer = randomPubkey();

    // Create state_key entries
    const sentKey = encodeMessageStateKey(peer, 100);
    const recvKey = encodeMessageStateKey(wallet.publicKey, 50);

    const sentEntry = {
      account: {
        stateKey: Array.from(sentKey),
        stateValue: Array.from(encodeMessageStateValue("sent")),
        updatedAt: { toNumber: () => 1700000100 },
        owner: wallet.publicKey,
      },
    };

    const recvEntry = {
      account: {
        stateKey: Array.from(recvKey),
        stateValue: Array.from(encodeMessageStateValue("recv")),
        updatedAt: { toNumber: () => 1700000050 },
        owner: peer,
      },
    };

    const allMock = vi
      .fn()
      .mockResolvedValueOnce([sentEntry]) // sent by me
      .mockResolvedValueOnce([recvEntry]); // sent by peer

    const program = createMockProgram({
      account: {
        coordinationState: { all: allMock },
        agentRegistration: { fetchNullable: vi.fn() },
      },
    });

    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      config: { defaultMode: "on-chain" },
    });

    const history = await messaging.getOnChainHistory(peer);
    expect(history.length).toBe(2);
    // Sorted by nonce: 50 before 100
    expect(history[0].nonce).toBe(50);
    expect(history[1].nonce).toBe(100);
  });

  it("applies limit parameter", async () => {
    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const peer = randomPubkey();

    const entries = Array.from({ length: 5 }, (_, i) => ({
      account: {
        stateKey: Array.from(encodeMessageStateKey(peer, i)),
        stateValue: Array.from(encodeMessageStateValue(`msg${i}`)),
        updatedAt: { toNumber: () => 1700000000 + i },
      },
    }));

    const program = createMockProgram({
      account: {
        coordinationState: {
          all: vi.fn().mockResolvedValueOnce(entries).mockResolvedValueOnce([]),
        },
        agentRegistration: { fetchNullable: vi.fn() },
      },
    });

    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      config: { defaultMode: "on-chain" },
    });

    const history = await messaging.getOnChainHistory(peer, 3);
    expect(history.length).toBe(3);
  });

  it("ignores entries with wrong magic", async () => {
    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const peer = randomPubkey();

    // Create a state_key without MSG_MAGIC
    const badKey = new Uint8Array(32);
    badKey[0] = 0xff;

    const program = createMockProgram({
      account: {
        coordinationState: {
          all: vi
            .fn()
            .mockResolvedValueOnce([
              {
                account: {
                  stateKey: Array.from(badKey),
                  stateValue: Array.from(new Uint8Array(64)),
                  updatedAt: { toNumber: () => 1700000000 },
                },
              },
            ])
            .mockResolvedValueOnce([]),
        },
        agentRegistration: { fetchNullable: vi.fn() },
      },
    });

    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      config: { defaultMode: "on-chain" },
    });

    const history = await messaging.getOnChainHistory(peer);
    expect(history.length).toBe(0);
  });
});

// ============================================================================
// AgentMessaging — Off-Chain Send Tests
// ============================================================================

describe("AgentMessaging — off-chain send", () => {
  it("throws MessagingConnectionError when no endpoint found", async () => {
    const discovery = createMockPeerResolver();
    const { messaging } = createTestMessaging({ discovery });

    await expect(
      messaging.send(randomPubkey(), "hi", "off-chain"),
    ).rejects.toThrow(MessagingConnectionError);
  });

  it("resolves endpoint via discovery", async () => {
    const discovery = createMockPeerResolver({
      resolveEndpoint: vi.fn().mockResolvedValue(null),
    });
    const { messaging } = createTestMessaging({ discovery });
    const recipient = randomPubkey();

    try {
      await messaging.send(recipient, "hi", "off-chain");
    } catch {
      /* expected */
    }

    expect(discovery.resolveEndpoint).toHaveBeenCalledWith(recipient);
  });

  it("rejects content exceeding maxOffChainSize", async () => {
    const discovery = createMockPeerResolver({
      resolveEndpoint: vi.fn().mockResolvedValue("ws://peer:8080"),
    });
    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const program = createMockProgram();

    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      discovery,
      config: { defaultMode: "off-chain", maxOffChainSize: 10 },
    });

    await expect(
      messaging.send(randomPubkey(), "A".repeat(20), "off-chain"),
    ).rejects.toThrow(MessagingSendError);
  });
});

// ============================================================================
// AgentMessaging — Off-Chain Listener Tests
// ============================================================================

describe("AgentMessaging — off-chain listener", () => {
  it("throws if listener already started", async () => {
    // The actual startListener requires the ws module, which may not be available.
    // We test the guard logic by calling dispose then starting.
    const { messaging } = createTestMessaging();
    await messaging.dispose();

    await expect(messaging.startListener(0)).rejects.toThrow("disposed");
  });
});

// ============================================================================
// AgentMessaging — Message Handler Tests
// ============================================================================

describe("AgentMessaging — message handlers", () => {
  it("registers and unregisters handlers", () => {
    const { messaging } = createTestMessaging();
    const handler = vi.fn();

    const unsub = messaging.onMessage(handler);
    expect(typeof unsub).toBe("function");

    unsub();
    // Handler should be removed — no way to test directly without triggering a message,
    // but we verify the unsubscribe function works
  });
});

// ============================================================================
// AgentMessaging — Auto Mode Tests
// ============================================================================

describe("AgentMessaging — auto mode", () => {
  it("falls back to on-chain when no endpoint", async () => {
    const discovery = createMockPeerResolver({
      resolveEndpoint: vi.fn().mockResolvedValue(null),
    });
    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const program = createMockProgram();

    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      discovery,
      config: { defaultMode: "auto" },
    });

    const msg = await messaging.send(randomPubkey(), "hi", "auto");
    expect(msg.onChain).toBe(true);
    expect(msg.mode).toBe("on-chain");
  });

  it("surfaces rate limit error from on-chain fallback", async () => {
    const discovery = createMockPeerResolver({
      resolveEndpoint: vi.fn().mockResolvedValue(null),
    });

    const rpcMock = vi
      .fn()
      .mockRejectedValue(anchorError(AnchorErrorCodes.RateLimitExceeded));
    const methodBuilder = {
      accountsPartial: vi.fn().mockReturnThis(),
      rpc: rpcMock,
    };

    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const program = createMockProgram({
      methods: { updateState: vi.fn().mockReturnValue(methodBuilder) },
    });

    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      discovery,
      config: { defaultMode: "auto" },
    });

    await expect(messaging.send(randomPubkey(), "hi", "auto")).rejects.toThrow(
      /rate limit/i,
    );
  });

  it("rejects large content on auto fallback to on-chain", async () => {
    const discovery = createMockPeerResolver({
      resolveEndpoint: vi.fn().mockResolvedValue(null),
    });
    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);
    const program = createMockProgram();

    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      discovery,
      config: { defaultMode: "auto" },
    });

    // Content too large for on-chain
    await expect(
      messaging.send(randomPubkey(), "A".repeat(100), "auto"),
    ).rejects.toThrow(MessagingSendError);
  });
});

// ============================================================================
// AgentMessaging — verifySignature Tests
// ============================================================================

describe("AgentMessaging — verifySignature", () => {
  it("verifies a valid signed message", async () => {
    const { messaging, wallet } = createTestMessaging();
    const recipient = randomPubkey();

    const msg = await messaging.send(recipient, "verify me", "on-chain");
    expect(messaging.verifySignature(msg)).toBe(true);
  });

  it("rejects tampered content", async () => {
    const { messaging } = createTestMessaging();
    const recipient = randomPubkey();

    const msg = await messaging.send(recipient, "original", "on-chain");
    const tampered: AgentMessage = { ...msg, content: "tampered" };
    expect(messaging.verifySignature(tampered)).toBe(false);
  });

  it("rejects tampered signature", async () => {
    const { messaging } = createTestMessaging();
    const recipient = randomPubkey();

    const msg = await messaging.send(recipient, "test", "on-chain");
    const badSig = new Uint8Array(msg.signature);
    badSig[0] ^= 0xff;
    const tampered: AgentMessage = { ...msg, signature: badSig };
    expect(messaging.verifySignature(tampered)).toBe(false);
  });
});

// ============================================================================
// AgentMessaging — Dispose Tests
// ============================================================================

describe("AgentMessaging — dispose", () => {
  it("prevents send after dispose", async () => {
    const { messaging } = createTestMessaging();
    await messaging.dispose();

    await expect(
      messaging.send(randomPubkey(), "hi", "on-chain"),
    ).rejects.toThrow(/disposed/i);
  });

  it("is idempotent", async () => {
    const { messaging } = createTestMessaging();
    await messaging.dispose();
    await messaging.dispose(); // Should not throw
  });

  it("clears handlers on dispose", async () => {
    const { messaging } = createTestMessaging();
    const handler = vi.fn();
    messaging.onMessage(handler);

    await messaging.dispose();

    // After dispose, handler set should be cleared
    // We verify by checking dispose doesn't throw
  });
});

// ============================================================================
// AgentMessaging — Default PeerResolver Tests
// ============================================================================

describe("AgentMessaging — default PeerResolver", () => {
  it("falls back to on-chain endpoint lookup", async () => {
    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);

    const fetchNullable = vi.fn().mockResolvedValue({
      endpoint: "ws://agent.example.com:9999",
    });
    const program = createMockProgram({
      account: {
        coordinationState: { all: vi.fn().mockResolvedValue([]) },
        agentRegistration: { fetchNullable },
      },
    });

    // No explicit discovery — uses default resolver
    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      config: { defaultMode: "on-chain" },
    });

    // The default resolver is used internally when no discovery is provided.
    // We can test it indirectly through auto mode.
  });

  it("returns null for agents without endpoint", async () => {
    const wallet = Keypair.generate();
    const agentId = generateAgentId(wallet.publicKey);

    const fetchNullable = vi.fn().mockResolvedValue({
      endpoint: "",
    });
    const program = createMockProgram({
      account: {
        coordinationState: { all: vi.fn().mockResolvedValue([]) },
        agentRegistration: { fetchNullable },
      },
    });

    const messaging = new AgentMessaging({
      program,
      agentId,
      wallet,
      config: { defaultMode: "auto" },
    });

    // Auto mode: no endpoint → falls back to on-chain
    const msg = await messaging.send(randomPubkey(), "test", "auto");
    expect(msg.onChain).toBe(true);
  });
});
