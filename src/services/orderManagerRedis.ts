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
 * Redis-based Order Manager - Production-grade order storage and indexing
 *
 * Why Redis?
 * - Fast sorted sets for price-ordered orderbook (O(log N) inserts)
 * - Atomic operations prevent race conditions during matching
 * - Persistence survives server restarts
 * - Scales horizontally with Upstash
 *
 * Data structure design:
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ Redis Key                            │ Type        │ Purpose        │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ order:{orderId}                      │ Hash        │ Full order     │
 * │ market:{marketId}:orders             │ Set         │ Order IDs      │
 * │ user:{address}:orders                │ Set         │ User's orders  │
 * │ orderbook:{marketId}:{posId}:buy     │ Sorted Set  │ Bids (price)   │
 * │ orderbook:{marketId}:{posId}:sell    │ Sorted Set  │ Asks (price)   │
 * │ orderbook:{marketId}:{posId}:cache   │ String      │ 10s cache      │
 * │ market:{marketId}                    │ Hash        │ Market data    │
 * │ markets                              │ Set         │ All market IDs │
 * │ lock:order:{orderId}                 │ String      │ Fill lock      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Example flow for "BUY 100 YES @ 66¢":
 * 1. addOrder() → stores in order:{id}, adds to sorted set @ score=66
 * 2. matchingEngine → reads from sorted set (auto-sorted by price)
 * 3. fillOrder() → acquires lock, updates filledSize, removes if filled
 */
export class OrderManagerRedis {
  // ========== ORDER MANAGEMENT ==========

  /**
   * Add new order to Redis - atomically stores and indexes
   *
   * Atomic pipeline ensures all-or-nothing:
   * 1. Store full order as hash
   * 2. Add to market index (for fetching all market orders)
   * 3. Add to user index (for portfolio view)
   * 4. Add to sorted orderbook (for matching engine)
   *
   * Example: BUY 100 YES @ 66¢
   *   - Stored at order:{orderId}
   *   - Added to orderbook:market1:0xabc...:buy with score=66
   *   - Matching engine will see this at position 66 in sorted set
   */
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

    // Redis multi = all commands execute atomically (all succeed or all fail)
    const multi = redis.multi();

    // Convert order to flat object for HSET
    const orderHash: Record<string, string> = {};
    for (const [key, value] of Object.entries(fullOrder)) {
      orderHash[key] = String(value);
    }

    // 1. Store complete order as hash (key-value pairs)
    multi.hSet(`order:${orderId}`, orderHash);

    // 2. Index by market (enables getMarketOrders query)
    multi.sAdd(`market:${order.marketId}:orders`, orderId);

    // 3. Index by user (enables getUserOrders query)
    multi.sAdd(`user:${order.maker}:orders`, orderId);

    // 4. Add to price-sorted orderbook (enables matching engine to find best prices)
    // Sorted set score = price, enables O(log N) range queries
    const primaryBookKey = this.getOrderbookKey(order.marketId, order);
    const legacyBookKey = this.getLegacyOrderbookKey(order.marketId, order);

    // Both buy and sell stored with score=price
    multi.zAdd(primaryBookKey, { score: order.price, value: orderId });

    if (legacyBookKey && legacyBookKey !== primaryBookKey) {
      multi.zAdd(legacyBookKey, { score: order.price, value: orderId });
    }

    // Execute all 4 commands atomically
    await multi.exec();

    console.log(
      `📝 New order: ${orderId} - ${order.side} ${order.size} @ ${order.price}`
    );

    // Invalidate caches for both primary and legacy books
    await this.invalidateOrderbookCaches(order.marketId, [
      this.resolveBookPositionId(order),
      order.makerPositionId,
    ]);

    return fullOrder;
  }

  async getOrder(orderId: string): Promise<Order | null> {
    const orderData = await redis.hGetAll(`order:${orderId}`);

    if (!orderData || Object.keys(orderData).length === 0) {
      return null;
    }

    return this.parseOrder(orderData as Record<string, string>);
  }

  async getMarketOrders(marketId: string): Promise<Order[]> {
    const orderIds = await redis.sMembers(`market:${marketId}:orders`);

    if (orderIds.length === 0) {
      return [];
    }

    const orders = await Promise.all(
      orderIds.map((id) => this.getOrder(id))
    );

    return orders.filter((order): order is Order => order !== null);
  }

  async getUserOrders(userAddress: string): Promise<Order[]> {
    const orderIds = await redis.sMembers(`user:${userAddress}:orders`);

    if (orderIds.length === 0) {
      return [];
    }

    const orders = await Promise.all(
      orderIds.map((id) => this.getOrder(id))
    );

    return orders.filter((order): order is Order => order !== null);
  }

  /**
   * Fill order - update filled amount atomically with distributed lock
   *
   * Why locks?
   * - Matching engine runs every 100ms, multiple matches can happen simultaneously
   * - Without locks: race condition where 2 matches both think order has 100 remaining
   * - With locks: only 1 match can update at a time, prevents double-spending
   *
   * Lock mechanism (since Upstash doesn't support Redis WATCH):
   * 1. Try to acquire exclusive lock (SET NX = set if not exists)
   * 2. If locked by another process, return false (caller retries)
   * 3. Read order, validate, update filledSize
   * 4. Remove from orderbook if fully filled
   * 5. Release lock
   *
   * Example: Order size=100, two matches of 60 each arrive simultaneously
   *   Match A: acquires lock, fills 60, remaining=40, releases lock
   *   Match B: acquires lock, tries to fill 60 but only 40 remaining, fills 40, releases lock
   */
  async fillOrder(orderId: string, fillSize: number): Promise<boolean> {
    if (fillSize <= 0) {
      return false;
    }

    const orderKey = `order:${orderId}`;

    // Distributed lock prevents concurrent fills (critical for matching engine)
    const lockKey = `lock:order:${orderId}`;
    const lockId = randomBytes(8).toString("hex"); // Unique lock ID to prevent accidental unlock
    const locked = await redis.set(lockKey, lockId, { NX: true, PX: 5000 }); // 5s timeout
    if (locked !== "OK") {
      return false; // Another process is filling this order, retry later
    }

    try {
      const orderData = await redis.hGetAll(orderKey);
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
      const primaryBookKey = this.getOrderbookKey(order.marketId, order);
      const legacyBookKey = this.getLegacyOrderbookKey(order.marketId, order);

      const multi = redis.multi();

      multi.hSet(orderKey, {
        filledSize: newFilledSize.toString(),
        remainingSize: newRemainingSize.toString(),
        status: newStatus.toString(),
        updatedAt: Date.now().toString(),
      });

      if (newRemainingSize <= 0) {
        multi.zRem(primaryBookKey, orderId);
        if (legacyBookKey && legacyBookKey !== primaryBookKey) {
          multi.zRem(legacyBookKey, orderId);
        }
      }

      this.enqueueCacheInvalidations(multi, order.marketId, [
        this.resolveBookPositionId(order),
        order.makerPositionId,
      ]);

      await multi.exec();

      if (newRemainingSize <= 0) {
        console.log(`✅ Order filled: ${orderId}`);
      } else {
        console.log(`⚡ Order partially filled: ${orderId} (${newFilledSize}/${order.size})`);
      }
      return true;
    } finally {
      const current = await redis.get(lockKey);
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

    const multi = redis.multi();

    // Update status
    multi.hSet(`order:${orderId}`, {
      status: OrderStatus.CANCELLED.toString(),
      updatedAt: Date.now().toString(),
    });

    // Remove from orderbook
    const primaryBookKey = this.getOrderbookKey(order.marketId, order);
    const legacyBookKey = this.getLegacyOrderbookKey(order.marketId, order);
    multi.zRem(primaryBookKey, orderId);
    if (legacyBookKey && legacyBookKey !== primaryBookKey) {
      multi.zRem(legacyBookKey, orderId);
    }

    this.enqueueCacheInvalidations(multi, order.marketId, [
      this.resolveBookPositionId(order),
      order.makerPositionId,
    ]);

    await multi.exec();

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

    const multi = redis.multi();

    // Update status
    multi.hSet(`order:${orderId}`, {
      status: OrderStatus.EXPIRED.toString(),
      updatedAt: Date.now().toString(),
    });

    // Remove from orderbook
    const primaryBookKey = this.getOrderbookKey(order.marketId, order);
    const legacyBookKey = this.getLegacyOrderbookKey(order.marketId, order);
    multi.zRem(primaryBookKey, orderId);
    if (legacyBookKey && legacyBookKey !== primaryBookKey) {
      multi.zRem(legacyBookKey, orderId);
    }

    this.enqueueCacheInvalidations(multi, order.marketId, [
      this.resolveBookPositionId(order),
      order.makerPositionId,
    ]);

    await multi.exec();

    console.log(`⏰ Order expired: ${orderId}`);
    return true;
  }

  // ========== ORDERBOOK MANAGEMENT ==========

  /**
   * Get orderbook snapshot - aggregates orders by price level
   *
   * Performance optimization:
   * - 10-second cache reduces load (orderbooks don't change that fast)
   * - Sorted sets pre-sorted by price (O(log N) range query)
   * - Aggregation happens in-memory (sum sizes at same price)
   *
   * Example output for YES tokens:
   * {
   *   bids: [
   *     { price: 68, size: 200, orderCount: 2 },  // Best bid
   *     { price: 66, size: 500, orderCount: 3 },
   *   ],
   *   asks: [
   *     { price: 70, size: 150, orderCount: 1 },  // Best ask
   *     { price: 72, size: 300, orderCount: 2 },
   *   ]
   * }
   * → Spread = 70 - 68 = 2¢
   */
  async getOrderbook(
    marketId: string,
    positionId: string,
    legacyPositionId?: string
  ): Promise<{ bids: OrderbookLevel[]; asks: OrderbookLevel[] }> {
    // Check 10s cache first (orderbook doesn't change every millisecond)
    const cacheKey = `orderbook:${marketId}:${positionId}:cache`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached); // Parse JSON from Redis
    }

    // Build from sorted sets
    const bidsKeys = [
      `orderbook:${marketId}:${positionId}:buy`,
      ...(legacyPositionId && legacyPositionId !== positionId
        ? [`orderbook:${marketId}:${legacyPositionId}:buy`]
        : []),
    ];

    const asksKeys = [
      `orderbook:${marketId}:${positionId}:sell`,
      ...(legacyPositionId && legacyPositionId !== positionId
        ? [`orderbook:${marketId}:${legacyPositionId}:sell`]
        : []),
    ];

    const [bidsRaw, asksRaw] = await Promise.all([
      this.collectOrderbookEntries(bidsKeys, true),
      this.collectOrderbookEntries(asksKeys, false),
    ]);

    // Parse and aggregate by price level
    const bids = await this.aggregateOrderbook(bidsRaw, true, positionId);
    const asks = await this.aggregateOrderbook(asksRaw, false, positionId);

    const result = { bids, asks };

    // Cache for 10 seconds
    await redis.setEx(cacheKey, 10, JSON.stringify(result));

    return result;
  }

  private async collectOrderbookEntries(
    keys: string[],
    isBid: boolean
  ): Promise<Array<{ score: number; value: string }>> {
    if (keys.length === 0) return [];

    const results = await Promise.all(
      keys.map((key) =>
        isBid
          ? redis.zRangeWithScores(key, 0, -1, { REV: true })
          : redis.zRangeWithScores(key, 0, -1)
      )
    );

    return results.flat();
  }

  private async aggregateOrderbook(
    rawData: Array<{ score: number; value: string }>,
    isBid: boolean,
    positionId: string
  ): Promise<OrderbookLevel[]> {
    const levels = new Map<number, { size: number; count: number }>();
    const seenOrders = new Set<string>();

    // rawData format: array of {score: price, value: orderId}
    for (const item of rawData) {
      const orderId = item.value;
      const price = item.score;

      if (seenOrders.has(orderId)) {
        continue;
      }

      const order = await this.getOrder(orderId);
      if (!order) continue;

      // Only include open and partially filled orders
      if (
        order.status !== OrderStatus.OPEN &&
        order.status !== OrderStatus.PARTIALLY_FILLED
      ) {
        continue;
      }

      if (
        (isBid && order.takerPositionId !== positionId) ||
        (!isBid && order.makerPositionId !== positionId)
      ) {
        continue;
      }

      seenOrders.add(orderId);

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
    const multi = redis.multi();

    // Convert market to flat object for HSET
    const marketHash: Record<string, string> = {};
    for (const [key, value] of Object.entries(market)) {
      marketHash[key] = String(value);
    }

    // Store market as hash
    multi.hSet(`market:${market.marketId}`, marketHash);

    // Add to markets set
    multi.sAdd("markets", market.marketId);

    await multi.exec();

    console.log(`📊 New market: ${market.marketId} - "${market.question}"`);
  }

  // ========== HELPERS ==========

  private resolveBookPositionId(order: {
    side: OrderSide;
    makerPositionId: string;
    takerPositionId: string;
  }): string {
    return order.side === OrderSide.BUY
      ? order.takerPositionId
      : order.makerPositionId;
  }

  private getOrderbookKey(
    marketId: string,
    order: {
      side: OrderSide;
      makerPositionId: string;
      takerPositionId: string;
    }
  ): string {
    const positionId = this.resolveBookPositionId(order);
    return `orderbook:${marketId}:${positionId}:${order.side.toLowerCase()}`;
  }

  private getLegacyOrderbookKey(
    marketId: string,
    order: {
      side: OrderSide;
      makerPositionId: string;
      takerPositionId: string;
    }
  ): string | null {
    // Legacy stored both BUY and SELL under makerPositionId
    const legacyPositionId = order.makerPositionId;
    return `orderbook:${marketId}:${legacyPositionId}:${order.side.toLowerCase()}`;
  }

  private enqueueCacheInvalidations(
    multi: ReturnType<typeof redis.multi>,
    marketId: string,
    positionIds: Array<string | undefined>
  ) {
    const unique = new Set(
      positionIds.filter((id): id is string => Boolean(id))
    );

    for (const positionId of unique) {
      multi.del(`orderbook:${marketId}:${positionId}:cache`);
    }
  }

  private async invalidateOrderbookCaches(
    marketId: string,
    positionIds: Array<string | undefined>
  ) {
    const unique = Array.from(
      new Set(positionIds.filter((id): id is string => Boolean(id)))
    );

    if (unique.length === 0) return;

    await Promise.all(
      unique.map((positionId) =>
        redis.del(`orderbook:${marketId}:${positionId}:cache`)
      )
    );
  }

  async getMarket(marketId: string): Promise<Market | null> {
    const marketData = await redis.hGetAll(`market:${marketId}`);

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
    const marketIds = await redis.sMembers("markets");

    if (!marketIds || marketIds.length === 0) {
      return [];
    }

    const markets = await Promise.all(
      marketIds.map((id: string) => this.getMarket(id))
    );

    return markets.filter((market): market is Market => market !== null);
  }

  // ========== STATS ==========

  async getOrderCount(): Promise<number> {
    const markets = await redis.sMembers("markets");
    if (!markets) return 0;

    let count = 0;

    for (const marketId of markets) {
      const marketOrdersCount = await redis.sCard(`market:${marketId}:orders`);
      count += marketOrdersCount || 0;
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
