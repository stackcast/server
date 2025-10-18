import type { StacksNetwork } from '@stacks/network';
import { createNetwork } from '@stacks/network';
import { OrderStatus } from "../types/order";
import { OrderManagerRedis } from "./orderManagerRedis";

/**
 * Stacks Block Height Monitor
 * Monitors Stacks blockchain for current block height and expires orders
 */
export class StacksMonitor {
  private orderManager: OrderManagerRedis;
  private network: StacksNetwork;
  private running: boolean = false;
  private monitorInterval: Timer | null = null;
  private currentBlockHeight: number = 0;
  private readonly POLL_INTERVAL_MS = 30000; // Check every 30 seconds

  constructor(
    orderManager: OrderManagerRedis,
    networkType: "mainnet" | "testnet" | "devnet" = "testnet"
  ) {
    this.orderManager = orderManager;

    // Initialize network with custom API URL if provided
    const apiUrl = process.env.STACKS_API_URL;
    this.network = apiUrl
      ? createNetwork({
          network: networkType,
          client: { baseUrl: apiUrl },
        })
      : createNetwork(networkType);
  }

  /**
   * Start monitoring block height
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    console.log("⛓️  Stacks block monitor started");

    // Initial fetch
    this.updateBlockHeight().catch((err) => {
      console.error("Failed to fetch initial block height:", err);
    });

    // Poll for updates
    this.monitorInterval = setInterval(() => {
      this.updateBlockHeight().catch((err) => {
        console.error("Failed to update block height:", err);
      });
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    console.log("⏸️  Stacks block monitor stopped");
  }

  /**
   * Get current block height
   */
  getCurrentBlockHeight(): number {
    return this.currentBlockHeight;
  }

  /**
   * Fetch current block height from Stacks API
   */
  private async updateBlockHeight(): Promise<void> {
    try {
      const apiUrl = this.network.client.baseUrl;
      const response = await fetch(`${apiUrl}/extended/v1/block?limit=1`);

      if (!response.ok) {
        throw new Error(`Failed to fetch block height: ${response.statusText}`);
      }

      const data = await response.json() as {
        results?: Array<{ height: number }>;
      };
      const newHeight = data.results?.[0]?.height || 0;

      if (newHeight > this.currentBlockHeight) {
        const oldHeight = this.currentBlockHeight;
        this.currentBlockHeight = newHeight;

        console.log(`📦 Block height updated: ${oldHeight} → ${newHeight}`);

        // Check for expired orders
        await this.checkExpiredOrders();
      }
    } catch (error) {
      console.error("Error fetching block height:", error);
    }
  }

  /**
   * Check all markets for expired orders and expire them
   */
  private async checkExpiredOrders(): Promise<void> {
    try {
      const markets = await this.orderManager.getAllMarkets();

      for (const market of markets) {
        if (market.resolved) continue;

        const orders = await this.orderManager.getMarketOrders(market.marketId);

        for (const order of orders) {
          // Check if order is expired based on block height
          if (
            (order.status === OrderStatus.OPEN ||
              order.status === OrderStatus.PARTIALLY_FILLED) &&
            order.expiration < this.currentBlockHeight
          ) {
            await this.orderManager.expireOrder(order.orderId);
            console.log(
              `⏰ Expired order ${order.orderId} (expiration: ${order.expiration}, current: ${this.currentBlockHeight})`
            );
          }
        }
      }
    } catch (error) {
      console.error("Error checking expired orders:", error);
    }
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }
}
