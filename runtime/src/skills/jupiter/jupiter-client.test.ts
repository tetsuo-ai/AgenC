import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JupiterClient, JupiterApiError } from "./jupiter-client.js";
import { silentLogger } from "../../utils/logger.js";
import { JUPITER_API_BASE_URL } from "./constants.js";

// Mock fetch globally
const mockFetch = vi.fn();

describe("JupiterClient", () => {
  let client: JupiterClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();

    client = new JupiterClient({
      apiBaseUrl: JUPITER_API_BASE_URL,
      timeoutMs: 5000,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getQuote", () => {
    it("returns parsed quote from Jupiter API", async () => {
      const mockResponse = {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "1000000000",
        outAmount: "25500000",
        otherAmountThreshold: "25245000",
        priceImpactPct: "0.01",
        routePlan: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const quote = await client.getQuote({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 1_000_000_000n,
        slippageBps: 50,
      });

      expect(quote.inputMint).toBe(
        "So11111111111111111111111111111111111111112",
      );
      expect(quote.outputMint).toBe(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
      expect(quote.inAmount).toBe(1_000_000_000n);
      expect(quote.outAmount).toBe(25_500_000n);
      expect(quote.otherAmountThreshold).toBe(25_245_000n);
      expect(quote.priceImpactPct).toBe(0.01);
      expect(quote.rawQuote).toBeDefined();

      // Verify fetch was called with correct URL
      expect(mockFetch).toHaveBeenCalledOnce();
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("/quote");
      expect(callUrl).toContain(
        "inputMint=So11111111111111111111111111111111111111112",
      );
      expect(callUrl).toContain("amount=1000000000");
      expect(callUrl).toContain("slippageBps=50");
    });

    it("includes onlyDirectRoutes param when set", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          inputMint: "a",
          outputMint: "b",
          inAmount: "100",
          outAmount: "200",
          otherAmountThreshold: "190",
          priceImpactPct: "0",
        }),
      });

      await client.getQuote({
        inputMint: "a",
        outputMint: "b",
        amount: 100n,
        onlyDirectRoutes: true,
      });

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("onlyDirectRoutes=true");
    });

    it("throws JupiterApiError on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });

      await expect(
        client.getQuote({
          inputMint: "a",
          outputMint: "b",
          amount: 100n,
        }),
      ).rejects.toThrow(JupiterApiError);
    });

    it("throws on fetch timeout", async () => {
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            const err = new Error("aborted");
            err.name = "AbortError";
            setTimeout(() => reject(err), 10);
          }),
      );

      const fastClient = new JupiterClient({
        apiBaseUrl: JUPITER_API_BASE_URL,
        timeoutMs: 1,
        logger: silentLogger,
      });

      await expect(
        fastClient.getQuote({
          inputMint: "a",
          outputMint: "b",
          amount: 100n,
        }),
      ).rejects.toThrow();
    });
  });

  describe("getSwapTransaction", () => {
    it("returns serialized transaction bytes", async () => {
      const base64Tx = Buffer.from("mock-transaction-bytes").toString("base64");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ swapTransaction: base64Tx }),
      });

      const txBytes = await client.getSwapTransaction(
        { mock: "quote" },
        "So11111111111111111111111111111111111111112",
      );

      expect(txBytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(txBytes).toString()).toBe("mock-transaction-bytes");

      // Verify POST body
      expect(mockFetch).toHaveBeenCalledOnce();
      const callInit = mockFetch.mock.calls[0][1] as RequestInit;
      expect(callInit.method).toBe("POST");
      const body = JSON.parse(callInit.body as string);
      expect(body.userPublicKey).toBe(
        "So11111111111111111111111111111111111111112",
      );
      expect(body.wrapAndUnwrapSol).toBe(true);
    });

    it("throws if swapTransaction field is missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await expect(
        client.getSwapTransaction({ mock: "quote" }, "pubkey"),
      ).rejects.toThrow(JupiterApiError);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      await expect(
        client.getSwapTransaction({ mock: "quote" }, "pubkey"),
      ).rejects.toThrow(JupiterApiError);
    });
  });

  describe("getPrice", () => {
    it("returns price map for requested mints", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            So11111111111111111111111111111111111111112: {
              id: "So11111111111111111111111111111111111111112",
              price: 25.5,
            },
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
              id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              price: 1.0,
            },
          },
        }),
      });

      const prices = await client.getPrice([
        "So11111111111111111111111111111111111111112",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      ]);

      expect(prices.size).toBe(2);
      expect(
        prices.get("So11111111111111111111111111111111111111112")?.priceUsd,
      ).toBe(25.5);
      expect(
        prices.get("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?.priceUsd,
      ).toBe(1.0);
    });

    it("returns empty map for empty mints array", async () => {
      const prices = await client.getPrice([]);
      expect(prices.size).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate Limited",
      });

      await expect(client.getPrice(["mint"])).rejects.toThrow(JupiterApiError);
    });
  });
});
