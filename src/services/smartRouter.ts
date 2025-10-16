import type { OrderManagerRedis } from "./orderManagerRedis";
import { OrderSide } from "../types/order";

export enum OrderType {
  LIMIT = "LIMIT",
  MARKET = "MARKET",
}

export interface ExecutionLevel {
  price: number;
  size: number;
  cumulativeSize: number;
  cost: number; // Total cost at this level
}

export interface ExecutionPlan {
  orderType: OrderType;
  totalSize: number;
  levels: ExecutionLevel[];
  averagePrice: number;
  totalCost: number;
  slippage: number; // Percentage difference from best price
  worstPrice: number;
  bestPrice: number;
  feasible: boolean;
  reason?: string; // Why not feasible
}

export interface SmartRouterRequest {
  marketId: string;
  outcome: "yes" | "no"; // Which outcome token
  side: OrderSide; // BUY or SELL
  orderType: OrderType;
  size: number; // Total desired size
  limitPrice?: number; // For LIMIT orders, max price willing to pay (BUY) or min price to accept (SELL)
  maxSlippage?: number; // For MARKET orders, max acceptable slippage % (e.g., 5 = 5%)
}

/**
 * Smart Router - Multi-level order execution planner
 *
 * Purpose: Help users execute large orders with minimal slippage
 *
 * How it works:
 * 1. Analyzes available liquidity across all price levels
 * 2. Calculates how order would fill (may span multiple prices)
 * 3. Computes average price, slippage, and feasibility
 * 4. Returns execution plan (for preview or actual placement)
 *
 * Example: User wants to BUY 500 YES tokens
 * Orderbook asks: [65¢×200, 66¢×150, 68¢×300]
 *
 * Execution plan:
 * - Level 1: 200 @ 65¢ = 13,000¢
 * - Level 2: 150 @ 66¢ = 9,900¢
 * - Level 3: 150 @ 68¢ = 10,200¢
 * Total: 500 tokens for 33,100¢ = avg 66.2¢ (vs best 65¢ = 1.85% slippage)
 *
 * Benefits:
 * - Shows user exactly what they'll pay before placing order
 * - Prevents excessive slippage by rejecting if > maxSlippage
 * - Enables "one-click" market orders that span multiple levels
 */
export class SmartRouter {
  constructor(private orderManager: OrderManagerRedis) {}

  /**
   * Plan execution - simulates how an order would fill
   *
   * Returns detailed breakdown including:
   * - Which price levels would be hit
   * - How much size at each level
   * - Average execution price
   * - Slippage percentage
   * - Whether it's feasible (enough liquidity)
   */
  async planExecution(
    request: SmartRouterRequest
  ): Promise<ExecutionPlan> {
    const { marketId, outcome, side, orderType, size, limitPrice, maxSlippage } = request;

    // Get market data
    const market = await this.orderManager.getMarket(marketId);
    if (!market) {
      return this.createInfeasiblePlan(size, "Market not found");
    }

    // Determine position ID based on outcome
    const positionId =
      outcome === "yes" ? market.yesPositionId : market.noPositionId;

    // Get orderbook for this position
    const counterpartPositionId =
      positionId === market.yesPositionId
        ? market.noPositionId
        : market.yesPositionId;

    const orderbook = await this.orderManager.getOrderbook(
      marketId,
      positionId,
      counterpartPositionId
    );

    // For BUY orders, we match against asks (sellers)
    // For SELL orders, we match against bids (buyers)
    const levels = side === OrderSide.BUY ? orderbook.asks : orderbook.bids;

    if (levels.length === 0) {
      return this.createInfeasiblePlan(
        size,
        `No ${side === OrderSide.BUY ? "sellers" : "buyers"} available`
      );
    }

    // Sort levels by price (ascending for BUY, descending for SELL)
    const sortedLevels = [...levels].sort((a, b) =>
      side === OrderSide.BUY ? a.price - b.price : b.price - a.price
    );

    const bestPrice = sortedLevels[0].price;

    // Calculate execution across levels
    const executionLevels: ExecutionLevel[] = [];
    let remainingSize = size;
    let cumulativeSize = 0;
    let totalCost = 0;

    for (const level of sortedLevels) {
      if (remainingSize <= 0) break;

      // Check limit price constraint for LIMIT orders
      if (orderType === OrderType.LIMIT && limitPrice !== undefined) {
        if (side === OrderSide.BUY && level.price > limitPrice) {
          break; // Price too high for buyer
        }
        if (side === OrderSide.SELL && level.price < limitPrice) {
          break; // Price too low for seller
        }
      }

      // Calculate size to take from this level
      const sizeFromLevel = Math.min(remainingSize, level.size);
      cumulativeSize += sizeFromLevel;

      // Calculate cost (for both BUY and SELL, we use positive numbers)
      const levelCost = sizeFromLevel * level.price;
      totalCost += levelCost;

      executionLevels.push({
        price: level.price,
        size: sizeFromLevel,
        cumulativeSize,
        cost: levelCost,
      });

      remainingSize -= sizeFromLevel;
    }

    // Check if fully feasible
    const feasible = remainingSize <= 0;
    const actualSize = cumulativeSize;
    const averagePrice = actualSize > 0 ? totalCost / actualSize : 0;
    const worstPrice = executionLevels.length > 0
      ? executionLevels[executionLevels.length - 1].price
      : bestPrice;

    // Calculate slippage (how much worse than best price)
    const slippage = bestPrice > 0
      ? Math.abs((averagePrice - bestPrice) / bestPrice) * 100
      : 0;

    // Check max slippage constraint for MARKET orders
    if (orderType === OrderType.MARKET && maxSlippage !== undefined && slippage > maxSlippage) {
      return this.createInfeasiblePlan(
        size,
        `Slippage ${slippage.toFixed(2)}% exceeds maximum ${maxSlippage}%`
      );
    }

    if (!feasible) {
      return {
        orderType,
        totalSize: size,
        levels: executionLevels,
        averagePrice,
        totalCost,
        slippage,
        worstPrice,
        bestPrice,
        feasible: false,
        reason: `Insufficient liquidity. Only ${actualSize} of ${size} tokens available`,
      };
    }

    return {
      orderType,
      totalSize: size,
      levels: executionLevels,
      averagePrice,
      totalCost,
      slippage,
      worstPrice,
      bestPrice,
      feasible: true,
    };
  }

  /**
   * Helper to create an infeasible execution plan
   */
  private createInfeasiblePlan(size: number, reason: string): ExecutionPlan {
    return {
      orderType: OrderType.MARKET,
      totalSize: size,
      levels: [],
      averagePrice: 0,
      totalCost: 0,
      slippage: 0,
      worstPrice: 0,
      bestPrice: 0,
      feasible: false,
      reason,
    };
  }
}
