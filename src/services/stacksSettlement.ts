import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import type { Order, Trade } from '../types/order';
import { createNetwork, type StacksNetworkName } from '@stacks/network';
import {
  PostConditionMode,
  broadcastTransaction,
  bufferCV,
  makeContractCall,
  standardPrincipalCV,
  uintCV,
} from '@stacks/transactions';

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
 * Handles settlement of matched orders on the CTF exchange contract.
 *
 * The service is a thin wrapper around @stacks/transactions that translates
 * the in-memory trade representation into the contract call expected by
 * ctf-exchange.clar. It remains opt-in – if configuration is missing we just
 * skip the broadcast so local development can continue without a signer.
 */
export class StacksSettlementService {
  private readonly enabled: boolean;
  private readonly contractAddress?: string;
  private readonly contractName?: string;
  private readonly operatorKey?: string;
  private readonly network;

  constructor(config: SettlementConfig) {
    this.network = config.apiUrl
      ? createNetwork({ network: config.network, client: { baseUrl: config.apiUrl } })
      : createNetwork(config.network);

    if (config.contractIdentifier && config.operatorPrivateKey) {
      const [address, name] = config.contractIdentifier.split('.');

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
      if (!config.contractIdentifier) missing.push('CTF_EXCHANGE_ADDRESS');
      if (!config.operatorPrivateKey) missing.push('STACKS_OPERATOR_PRIVATE_KEY');
      if (missing.length > 0) {
        console.warn(`Stacks settlement disabled: missing ${missing.join(', ')}`);
      }
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async submitFill(request: SettlementRequest): Promise<string | undefined> {
    if (!this.enabled || !this.contractAddress || !this.contractName || !this.operatorKey) {
      return undefined;
    }

    const { makerOrder, takerOrder, fillAmount } = request;

    const makerAmount = this.ensureInteger(makerOrder.size, 'maker size');
    const takerAmount = this.ensureInteger(
      Math.floor(makerOrder.price * makerOrder.size),
      'maker taker amount'
    );
    const fill = this.ensureInteger(fillAmount, 'fill amount');
    const salt = this.parseUint(makerOrder.salt ?? takerOrder.salt);
    const expiration = this.parseUint(makerOrder.expiration ?? takerOrder.expiration);

    // Contract expects: maker, maker-position-id, maker-amount, maker-signature,
    //                   taker, taker-position-id, taker-amount, taker-signature,
    //                   salt, expiration, fill-amount
    const functionArgs = [
      standardPrincipalCV(makerOrder.maker),
      bufferCV(this.positionIdToBuffer(makerOrder.makerPositionId)),
      uintCV(makerAmount),
      bufferCV(Buffer.from(makerOrder.signature || '0'.repeat(130), 'hex')), // Maker signature
      standardPrincipalCV(takerOrder.maker),
      bufferCV(this.positionIdToBuffer(takerOrder.makerPositionId)), // Taker's position is their maker position
      uintCV(takerAmount),
      bufferCV(Buffer.from(takerOrder.signature || '0'.repeat(130), 'hex')), // Taker signature
      uintCV(salt),
      uintCV(expiration),
      uintCV(fill),
    ];

    const tx = await makeContractCall({
      contractAddress: this.contractAddress,
      contractName: this.contractName,
      functionName: 'fill-order',
      functionArgs,
      senderKey: this.operatorKey,
      network: this.network,
      postConditionMode: PostConditionMode.Deny,
    });

    const broadcastResult = await broadcastTransaction({ transaction: tx, network: this.network });

    if ('txid' in broadcastResult && !('error' in broadcastResult)) {
      return broadcastResult.txid;
    }

    throw new Error(`Settlement broadcast rejected: ${JSON.stringify(broadcastResult)}`);
  }

  private ensureInteger(value: number, context: string): bigint {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${context} must be a non-negative finite number`);
    }

    if (!Number.isInteger(value)) {
      throw new Error(`${context} must be an integer for settlement (received ${value})`);
    }

    return BigInt(value);
  }

  private parseUint(value?: string | number | null): bigint {
    if (value === undefined || value === null) {
      return 0n;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid numeric value ${value}`);
      }
      if (!Number.isInteger(value)) {
        throw new Error(`Expected integer value, received ${value}`);
      }
      return BigInt(value);
    }

    if (typeof value === 'string') {
      if (value.trim().length === 0) {
        return 0n;
      }
      if (!/^[0-9]+$/.test(value)) {
        throw new Error(`Expected numeric string, received "${value}"`);
      }
      return BigInt(value);
    }

    throw new Error('Unsupported value type for parseUint');
  }

  private positionIdToBuffer(positionId: string): Uint8Array {
    if (/^[0-9a-fA-F]{64}$/.test(positionId)) {
      return Buffer.from(positionId, 'hex');
    }

    // Fallback: derive a stable 32-byte identifier from the plain string.
    return createHash('sha256').update(positionId).digest();
  }

  private resolveTakerPositionId(makerPositionId: string, takerPositionId?: string): string {
    if (takerPositionId && takerPositionId !== makerPositionId) {
      return takerPositionId;
    }

    if (makerPositionId.endsWith('_yes')) {
      return makerPositionId.replace(/_yes$/, '_no');
    }

    if (makerPositionId.endsWith('_no')) {
      return makerPositionId.replace(/_no$/, '_yes');
    }

    return takerPositionId || makerPositionId;
  }
}
