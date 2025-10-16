import { createNetwork, type StacksNetworkName } from "@stacks/network";
import {
  PostConditionMode,
  broadcastTransaction,
  bufferCV,
  makeContractCall,
  standardPrincipalCV,
  uintCV,
} from "@stacks/transactions";
import { Buffer } from "buffer";
import type { Order, Trade } from "../types/order";

type SettlementConfig = {
  network: StacksNetworkName;
  contractIdentifier?: string;
  operatorPrivateKey?: string;
  apiUrl?: string;
};

type SettlementRequest = {
  trade: Trade;
  makerOrder: Order; // resting order on the book
  takerOrder: Order; // incoming order that crossed the book
  fillAmount: number;
  executionPrice: number;
};

/**
 * Stacks Settlement Service - On-chain trade execution
 *
 * Bridges off-chain matching → on-chain settlement
 *
 * Flow:
 * 1. Matching engine pairs orders off-chain (fast, no gas)
 * 2. Settlement service translates match → ctf-exchange.fill-order() call
 * 3. Broadcasts Stacks transaction with both maker + taker signatures
 * 4. Smart contract verifies signatures, swaps position tokens atomically
 * 5. Returns txid, updates trade record
 *
 * Why hybrid model?
 * - Off-chain matching: Fast (100ms), no gas costs for failed matches
 * - On-chain settlement: Trustless atomic swaps, verifiable on blockchain
 * - Best of both: Speed + security
 *
 * Example: BUY 100 YES @ 66¢ matched with SELL 100 YES @ 66¢
 * → Calls ctf-exchange.fill-order with:
 *    - Maker order: SELL 100 YES, signature A
 *    - Taker order: BUY 100 YES, signature B
 *    - Fill amount: 100
 * → Contract transfers: 100 YES (seller→buyer), 6600¢ worth of NO (buyer→seller)
 * → 0.5% fee taken by protocol
 *
 * Opt-in design: If env vars missing, just skips broadcast (local dev friendly)
 */
export class StacksSettlementService {
  private readonly enabled: boolean;
  private readonly contractAddress?: string;
  private readonly contractName?: string;
  private readonly operatorKey?: string;
  private readonly network;

  constructor(config: SettlementConfig) {
    this.network = config.apiUrl
      ? createNetwork({
          network: config.network,
          client: { baseUrl: config.apiUrl },
        })
      : createNetwork(config.network);

    if (config.contractIdentifier && config.operatorPrivateKey) {
      const [address, name] = config.contractIdentifier.split(".");

      if (!address || !name) {
        console.warn(
          `StacksSettlementService disabled: invalid contract identifier "${config.contractIdentifier}"`
        );
        this.enabled = false;
        return;
      }

      this.contractAddress = address;
      this.contractName = name;
      this.operatorKey = config.operatorPrivateKey;
      this.enabled = true;
    } else {
      const missing: string[] = [];
      if (!config.contractIdentifier) missing.push("CTF_EXCHANGE_ADDRESS");
      if (!config.operatorPrivateKey)
        missing.push("STACKS_OPERATOR_PRIVATE_KEY");
      if (missing.length > 0) {
        console.warn(
          `Stacks settlement disabled: missing ${missing.join(", ")}`
        );
      }
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async submitFill(request: SettlementRequest): Promise<string | undefined> {
    if (
      !this.enabled ||
      !this.contractAddress ||
      !this.contractName ||
      !this.operatorKey
    ) {
      return undefined;
    }

    const { makerOrder, takerOrder, fillAmount } = request;

    const makerAmount = this.ensureInteger(makerOrder.size, "maker size");
    const takerAmount = this.ensureInteger(
      Math.floor(makerOrder.price * makerOrder.size),
      "maker taker amount"
    );
    const fill = this.ensureInteger(fillAmount, "fill amount");
    const salt = this.parseUint(makerOrder.salt ?? takerOrder.salt);
    const expiration = this.parseUint(
      makerOrder.expiration ?? takerOrder.expiration
    );

    // Validate signatures are present
    if (!makerOrder.signature || !takerOrder.signature) {
      throw new Error(
        "Both maker and taker signatures are required for settlement"
      );
    }

    // Ensure signatures are 65 bytes (130 hex chars)
    const makerSig = makerOrder.signature.replace(/^0x/, "");
    const takerSig = takerOrder.signature.replace(/^0x/, "");

    if (makerSig.length !== 130) {
      throw new Error(
        `Maker signature must be 65 bytes (130 hex chars), got ${makerSig.length} chars`
      );
    }
    if (takerSig.length !== 130) {
      throw new Error(
        `Taker signature must be 65 bytes (130 hex chars), got ${takerSig.length} chars`
      );
    }

    const functionArgs = [
      // Maker order details
      standardPrincipalCV(makerOrder.maker),
      bufferCV(this.positionIdToBuffer(makerOrder.makerPositionId)),
      uintCV(makerAmount),
      bufferCV(Buffer.from(makerSig, "hex")),
      // Taker order details
      standardPrincipalCV(takerOrder.maker),
      bufferCV(this.positionIdToBuffer(takerOrder.takerPositionId)),
      uintCV(takerAmount),
      bufferCV(Buffer.from(takerSig, "hex")),
      // Order metadata
      uintCV(salt),
      uintCV(expiration),
      // Fill amount
      uintCV(fill),
    ];

    const tx = await makeContractCall({
      contractAddress: this.contractAddress,
      contractName: this.contractName,
      functionName: "fill-order",
      functionArgs,
      senderKey: this.operatorKey,
      network: this.network,
      postConditionMode: PostConditionMode.Deny,
    });

    const broadcastResult = await broadcastTransaction({
      transaction: tx,
      network: this.network,
    });

    if ("txid" in broadcastResult && !("error" in broadcastResult)) {
      return broadcastResult.txid;
    }

    throw new Error(
      `Settlement broadcast rejected: ${JSON.stringify(broadcastResult)}`
    );
  }

  private ensureInteger(value: number, context: string): bigint {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${context} must be a non-negative finite number`);
    }

    if (!Number.isInteger(value)) {
      throw new Error(
        `${context} must be an integer for settlement (received ${value})`
      );
    }

    return BigInt(value);
  }

  private parseUint(value?: string | number | null): bigint {
    if (value === undefined || value === null) {
      return 0n;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid numeric value ${value}`);
      }
      if (!Number.isInteger(value)) {
        throw new Error(`Expected integer value, received ${value}`);
      }
      return BigInt(value);
    }

    if (typeof value === "string") {
      if (value.trim().length === 0) {
        return 0n;
      }
      if (!/^[0-9]+$/.test(value)) {
        throw new Error(`Expected numeric string, received "${value}"`);
      }
      return BigInt(value);
    }

    throw new Error("Unsupported value type for parseUint");
  }

  private positionIdToBuffer(positionId: string): Uint8Array {
    // Position IDs should always be 64 hex chars (32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(positionId)) {
      return Buffer.from(positionId, "hex");
    }

    throw new Error(
      `Position ID must be a 64-character hex string (32 bytes), got: ${positionId}`
    );
  }
}
