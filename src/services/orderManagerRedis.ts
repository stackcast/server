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
    // Use makerPositionId for orderbook organization
    const bookKey = `orderbook:${order.marketId}:${order.makerPositionId}:${order.side.toLowerCase()}`;
    if (order.side === OrderSide.BUY) {
      // Bids: higher price = higher score (reverse order later)
      pipeline.zadd(bookKey, { score: order.price, member: orderId });
    } else {
      // Asks: lower price = higher score
      pipeline.zadd(bookKey, { score: order.price, member: orderId });
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

    if (!orderData || Object.keys(orderData).length === 0) {
      return null;
    }

    return this.parseOrder(orderData as Record<string, string>);
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

    // Per-order lock to serialize fills (Upstash doesn't support WATCH for optimistic locking)
    const lockKey = `lock:order:${orderId}`;
    const lockId = randomBytes(8).toString("hex");
    const locked = await redis.set(lockKey, lockId, { nx: true, px: 5000 });
    if (locked !== "OK") {
      return false; // busy; caller may retry with backoff
    }

    try {
      const orderData = await redis.hgetall(orderKey);
      if (!orderData || Object.keys(orderData).length === 0) {
        return false;
      }

      const order = this.parseOrder(orderData as Record<string, string>);

      if (
        order.status === OrderStatus.FILLED ||
        order.status === OrderStatus.CANCELLED ||
        order.status === OrderStatus.EXPIRED
      ) {
        return false;
      }

      if (fillSize > order.remainingSize) {
        return false;
      }

      const newFilledSize = order.filledSize + fillSize;
      const newRemainingSize = order.remainingSize - fillSize;
      const newStatus =
        newRemainingSize <= 0 ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;
      const bookKey = `orderbook:${order.marketId}:${order.makerPositionId}:${order.side.toLowerCase()}`;

      const pipeline = redis.pipeline();

      pipeline.hset(orderKey, {
        filledSize: newFilledSize.toString(),
        remainingSize: newRemainingSize.toString(),
        status: newStatus.toString(),
        updatedAt: Date.now().toString(),
      });

      if (newRemainingSize <= 0) {
        pipeline.zrem(bookKey, orderId);
      }

      // Invalidate cached orderbook
      const cacheKey = `orderbook:${order.marketId}:${order.makerPositionId}:cache`;
      pipeline.del(cacheKey);

      await pipeline.exec();

      if (newRemainingSize <= 0) {
        console.log(`✅ Order filled: ${orderId}`);
      } else {
        console.log(`⚡ Order partially filled: ${orderId} (${newFilledSize}/${order.size})`);
      }
      return true;
    } finally {
      const current = await redis.get(lockKey) as string | null;
      if (current === lockId) {
        await redis.del(lockKey);
      }
    }
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
      return JSON.parse(cached as string);
    }

    // Build from sorted sets
    const bidsKey = `orderbook:${marketId}:${makerPositionId}:buy`;
    const asksKey = `orderbook:${marketId}:${makerPositionId}:sell`;

    // Get all orders with scores (prices)
    const [bidsRaw, asksRaw] = await Promise.all([
      redis.zrange(bidsKey, 0, -1, { rev: true, withScores: true }), // Reverse for bids (high to low)
      redis.zrange(asksKey, 0, -1, { withScores: true }),    // Normal for asks (low to high)
    ]);

    // Parse and aggregate by price level
    const bids = await this.aggregateOrderbook(bidsRaw as Array<{ score: number; member: string }>, true);
    const asks = await this.aggregateOrderbook(asksRaw as Array<{ score: number; member: string }>, false);

    const result = { bids, asks };

    // Cache for 10 seconds
    await redis.set(cacheKey, JSON.stringify(result), { ex: 10 });

    return result;
  }

  private async aggregateOrderbook(
    rawData: Array<{ score: number; member: string }>,
    isBid: boolean
  ): Promise<OrderbookLevel[]> {
    const levels = new Map<number, { size: number; count: number }>();

    // rawData format: array of {score: price, member: orderId}
    for (const item of rawData) {
      const orderId = item.member;
      const price = item.score;

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

    if (!marketData || Object.keys(marketData).length === 0) {
      return null;
    }

    const data = marketData as Record<string, string>;

    return {
      marketId: data.marketId,
      conditionId: data.conditionId,
      question: data.question,
      creator: data.creator,
      yesPositionId: data.yesPositionId,
      noPositionId: data.noPositionId,
      yesPrice: parseFloat(data.yesPrice),
      noPrice: parseFloat(data.noPrice),
      volume24h: parseFloat(data.volume24h),
      createdAt: parseInt(data.createdAt),
      resolved: data.resolved === "true",
      outcome: data.outcome ? parseInt(data.outcome) : undefined,
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
      publicKey: data.publicKey,
    };
  }
}
