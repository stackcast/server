import {
  Order,
  OrderSide,
  OrderStatus,
  OrderbookLevel,
  Market,
} from "../types/order";
import { randomBytes } from "crypto";
import { redis } from "./redisClient";

/**
 * Redis-based OrderManager for production persistence
 *
 * Data structure:
 * - order:{orderId} -> Hash (Order object)
 * - market:{marketId}:orders -> Set (order IDs)
 * - user:{address}:orders -> Set (order IDs)
 * - orderbook:{marketId}:{positionId}:bids -> Sorted Set (score=price, member=orderId)
 * - orderbook:{marketId}:{positionId}:asks -> Sorted Set (score=price, member=orderId)
 * - market:{marketId} -> Hash (Market object)
 * - markets -> Set (market IDs)
 */
export class OrderManagerRedis {
  // ========== ORDER MANAGEMENT ==========

  async addOrder(
    order: Omit<
      Order,
      | "orderId"
      | "filledSize"
      | "remainingSize"
      | "status"
      | "createdAt"
      | "updatedAt"
    >
  ): Promise<Order> {
    const orderId = this.generateOrderId();
    const now = Date.now();

    const fullOrder: Order = {
      ...order,
      orderId,
      filledSize: 0,
      remainingSize: order.size,
      status: OrderStatus.OPEN,
      createdAt: now,
      updatedAt: now,
    };

    // Use Redis pipeline for atomic multi-command transaction
    const pipeline = redis.pipeline();

    // Store order as hash
    pipeline.hset(`order:${orderId}`, {
      ...fullOrder,
      // Stringify complex fields
      side: fullOrder.side.toString(),
      status: fullOrder.status.toString(),
    });

    // Index by market
    pipeline.sadd(`market:${order.marketId}:orders`, orderId);

    // Index by user
    pipeline.sadd(`user:${order.maker}:orders`, orderId);

    // Add to orderbook sorted set (score = price for efficient range queries)
    const bookKey = `orderbook:${order.marketId}:${order.makerPositionId}:${order.side.toLowerCase()}`;
    if (order.side === OrderSide.BUY) {
      // Bids: higher price = higher score (reverse order later)
      pipeline.zadd(bookKey, order.price, orderId);
    } else {
      // Asks: lower price = higher score
      pipeline.zadd(bookKey, order.price, orderId);
    }

    // Execute all commands atomically
    await pipeline.exec();

    console.log(
      `📝 New order: ${orderId} - ${order.side} ${order.size} @ ${order.price}`
    );

    return fullOrder;
  }

  async getOrder(orderId: string): Promise<Order | null> {
    const orderData = await redis.hgetall(`order:${orderId}`);

    if (Object.keys(orderData).length === 0) {
      return null;
    }

    return this.parseOrder(orderData);
  }

  async getMarketOrders(marketId: string): Promise<Order[]> {
    const orderIds = await redis.smembers(`market:${marketId}:orders`);

    if (orderIds.length === 0) {
      return [];
    }

    const orders = await Promise.all(
      orderIds.map((id) => this.getOrder(id))
    );

    return orders.filter((order): order is Order => order !== null);
  }

  async getUserOrders(userAddress: string): Promise<Order[]> {
    const orderIds = await redis.smembers(`user:${userAddress}:orders`);

    if (orderIds.length === 0) {
      return [];
    }

    const orders = await Promise.all(
      orderIds.map((id) => this.getOrder(id))
    );

    return orders.filter((order): order is Order => order !== null);
  }

  async fillOrder(orderId: string, fillSize: number): Promise<boolean> {
    if (fillSize <= 0) {
      return false;
    }

    const orderKey = `order:${orderId}`;
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await redis.watch(orderKey);

      const orderData = await redis.hgetall(orderKey);
      if (Object.keys(orderData).length === 0) {
        await redis.unwatch();
        return false;
      }

      const order = this.parseOrder(orderData);

      if (
        order.status === OrderStatus.FILLED ||
        order.status === OrderStatus.CANCELLED ||
        order.status === OrderStatus.EXPIRED
      ) {
        await redis.unwatch();
        return false;
      }

      if (fillSize > order.remainingSize) {
        await redis.unwatch();
        return false;
      }

      const newFilledSize = order.filledSize + fillSize;
      const newRemainingSize = order.remainingSize - fillSize;
      const newStatus =
        newRemainingSize <= 0 ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;
      const bookKey = `orderbook:${order.marketId}:${order.makerPositionId}:${order.side.toLowerCase()}`;

      const transaction = redis.multi();

      transaction.hset(orderKey, {
        filledSize: newFilledSize,
        remainingSize: newRemainingSize,
        status: newStatus.toString(),
        updatedAt: Date.now(),
      });

      if (newRemainingSize <= 0) {
        transaction.zrem(bookKey, orderId);
      }

      const execResult = await transaction.exec();
      if (execResult !== null) {
        if (newRemainingSize <= 0) {
          console.log(`✅ Order filled: ${orderId}`);
        } else {
          console.log(
            `⚡ Order partially filled: ${orderId} (${newFilledSize}/${order.size})`
          );
        }
        return true;
      }
    }

    await redis.unwatch();
    console.warn(`⚠️ Failed to fill order due to concurrent updates: ${orderId}`);
    return false;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const order = await this.getOrder(orderId);
    if (!order) return false;

    if (
      order.status === OrderStatus.FILLED ||
      order.status === OrderStatus.CANCELLED
    ) {
      return false;
    }

    const pipeline = redis.pipeline();

    // Update status
    pipeline.hset(`order:${orderId}`, {
      status: OrderStatus.CANCELLED.toString(),
      updatedAt: Date.now(),
    });

    // Remove from orderbook
    const bookKey = `orderbook:${order.marketId}:${order.makerPositionId}:${order.side.toLowerCase()}`;
    pipeline.zrem(bookKey, orderId);

    await pipeline.exec();

    console.log(`❌ Order cancelled: ${orderId}`);
    return true;
  }

  async expireOrder(orderId: string): Promise<boolean> {
    const order = await this.getOrder(orderId);
    if (!order) return false;

    if (
      order.status === OrderStatus.FILLED ||
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.EXPIRED
    ) {
      return false;
    }

    const pipeline = redis.pipeline();

    // Update status
    pipeline.hset(`order:${orderId}`, {
      status: OrderStatus.EXPIRED.toString(),
      updatedAt: Date.now(),
    });

    // Remove from orderbook
    const bookKey = `orderbook:${order.marketId}:${order.makerPositionId}:${order.side.toLowerCase()}`;
    pipeline.zrem(bookKey, orderId);

    await pipeline.exec();

    console.log(`⏰ Order expired: ${orderId}`);
    return true;
  }

  // ========== ORDERBOOK MANAGEMENT ==========

  async getOrderbook(
    marketId: string,
    makerPositionId: string
  ): Promise<{ bids: OrderbookLevel[]; asks: OrderbookLevel[] }> {
    // Check cache first (10 second TTL)
    const cacheKey = `orderbook:${marketId}:${makerPositionId}:cache`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    // Build from sorted sets
    const bidsKey = `orderbook:${marketId}:${makerPositionId}:buy`;
    const asksKey = `orderbook:${marketId}:${makerPositionId}:sell`;

    // Get all orders with scores (prices)
    const [bidsRaw, asksRaw] = await Promise.all([
      redis.zrevrange(bidsKey, 0, -1, "WITHSCORES"), // Reverse for bids (high to low)
      redis.zrange(asksKey, 0, -1, "WITHSCORES"),    // Normal for asks (low to high)
    ]);

    // Parse and aggregate by price level
    const bids = await this.aggregateOrderbook(bidsRaw, true);
    const asks = await this.aggregateOrderbook(asksRaw, false);

    const result = { bids, asks };

    // Cache for 10 seconds
    await redis.setex(cacheKey, 10, JSON.stringify(result));

    return result;
  }

  private async aggregateOrderbook(
    rawData: string[],
    isBid: boolean
  ): Promise<OrderbookLevel[]> {
    const levels = new Map<number, { size: number; count: number }>();

    // rawData format: [orderId, price, orderId, price, ...]
    for (let i = 0; i < rawData.length; i += 2) {
      const orderId = rawData[i];
      const price = parseFloat(rawData[i + 1]);

      const order = await this.getOrder(orderId);
      if (!order) continue;

      // Only include open and partially filled orders
      if (
        order.status !== OrderStatus.OPEN &&
        order.status !== OrderStatus.PARTIALLY_FILLED
      ) {
        continue;
      }

      const existing = levels.get(price) || { size: 0, count: 0 };
      existing.size += order.remainingSize;
      existing.count += 1;
      levels.set(price, existing);
    }

    const result = Array.from(levels.entries()).map(([price, data]) => ({
      price,
      size: data.size,
      orderCount: data.count,
    }));

    // Sort: bids high to low, asks low to high
    return result.sort((a, b) =>
      isBid ? b.price - a.price : a.price - b.price
    );
  }

  // ========== MARKET MANAGEMENT ==========

  async addMarket(market: Market): Promise<void> {
    const pipeline = redis.pipeline();

    // Store market as hash
    pipeline.hset(`market:${market.marketId}`, {
      ...market,
      resolved: market.resolved.toString(),
    });

    // Add to markets set
    pipeline.sadd("markets", market.marketId);

    await pipeline.exec();

    console.log(`📊 New market: ${market.marketId} - "${market.question}"`);
  }

  async getMarket(marketId: string): Promise<Market | null> {
    const marketData = await redis.hgetall(`market:${marketId}`);

    if (Object.keys(marketData).length === 0) {
      return null;
    }

    return {
      marketId: marketData.marketId,
      conditionId: marketData.conditionId,
      question: marketData.question,
      creator: marketData.creator,
      yesPositionId: marketData.yesPositionId,
      noPositionId: marketData.noPositionId,
      yesPrice: parseFloat(marketData.yesPrice),
      noPrice: parseFloat(marketData.noPrice),
      volume24h: parseFloat(marketData.volume24h),
      createdAt: parseInt(marketData.createdAt),
      resolved: marketData.resolved === "true",
      outcome: marketData.outcome ? parseInt(marketData.outcome) : undefined,
    };
  }

  async getAllMarkets(): Promise<Market[]> {
    const marketIds = await redis.smembers("markets");

    if (marketIds.length === 0) {
      return [];
    }

    const markets = await Promise.all(
      marketIds.map((id) => this.getMarket(id))
    );

    return markets.filter((market): market is Market => market !== null);
  }

  // ========== STATS ==========

  async getOrderCount(): Promise<number> {
    const markets = await redis.smembers("markets");
    let count = 0;

    for (const marketId of markets) {
      const marketOrdersCount = await redis.scard(`market:${marketId}:orders`);
      count += marketOrdersCount;
    }

    return count;
  }

  // ========== HELPERS ==========

  private generateOrderId(): string {
    return `order_${Date.now()}_${randomBytes(8).toString("hex")}`;
  }

  private parseOrder(data: Record<string, string>): Order {
    return {
      orderId: data.orderId,
      maker: data.maker,
      marketId: data.marketId,
      conditionId: data.conditionId,
      makerPositionId: data.makerPositionId,
      takerPositionId: data.takerPositionId,
      side: data.side as OrderSide,
      price: parseFloat(data.price),
      size: parseFloat(data.size),
      filledSize: parseFloat(data.filledSize),
      remainingSize: parseFloat(data.remainingSize),
      status: data.status as OrderStatus,
      salt: data.salt,
      expiration: parseInt(data.expiration),
      createdAt: parseInt(data.createdAt),
      updatedAt: parseInt(data.updatedAt),
      signature: data.signature,
    };
  }
}
