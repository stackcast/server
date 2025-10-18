import {
  Order,
  OrderSide,
  OrderStatus,
  OrderbookLevel,
  Market,
} from "../types/order";
import { randomBytes } from "crypto";
import { redis } from "./redisClient";
import { DatabasePersistence } from "./databasePersistence";

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
  constructor(private readonly persistence?: DatabasePersistence) {}

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

    await this.writeOrderToRedis(fullOrder);

    console.log(
      `📝 New order: ${orderId} - ${order.side} ${order.size} @ ${order.price}`
    );

    await this.persistOrder(fullOrder);

    return fullOrder;
  }

  /**
   * Link original order with its complementary mirror order so that fills/cancels
   * update both records consistently.
   */
  async linkComplementaryOrders(
    originalOrderId: string,
    complementaryOrderId: string
  ): Promise<void> {
    const originalOrder = await this.getOrder(originalOrderId);
    if (!originalOrder) {
      return;
    }

    if (originalOrder.complementaryOrderId === complementaryOrderId) {
      return;
    }

    originalOrder.complementaryOrderId = complementaryOrderId;
    originalOrder.updatedAt = Date.now();

    await this.writeOrderToRedis(originalOrder);
    await this.persistOrder(originalOrder);
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
    // Get the order to check if it has a complementary order
    const order = await this.getOrder(orderId);
    if (!order) {
      return false;
    }

    // Fill the original order
    const result = await this.fillOrderInternal(orderId, fillSize);

    // Also fill the complementary order if it exists
    if (order.complementaryOrderId) {
      await this.fillOrderInternal(order.complementaryOrderId, fillSize);
    }

    return result;
  }

  private async fillOrderInternal(orderId: string, fillSize: number): Promise<boolean> {
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
      const bookPositionId = this.getBookPositionId(
        order.side,
        order.makerPositionId,
        order.takerPositionId
      );
      const bookKey = this.buildOrderbookKey(
        order.marketId,
        bookPositionId,
        order.side
      );

      const multi = redis.multi();

      const updatedAt = Date.now();

      multi.hSet(orderKey, {
        filledSize: newFilledSize.toString(),
        remainingSize: newRemainingSize.toString(),
        status: newStatus.toString(),
        updatedAt: updatedAt.toString(),
      });

      if (newRemainingSize <= 0) {
        multi.zRem(bookKey, orderId);
      }

      await multi.exec();

      await this.clearOrderbookCache(order.marketId, bookPositionId);

      order.filledSize = newFilledSize;
      order.remainingSize = newRemainingSize;
      order.status = newStatus;
      order.updatedAt = updatedAt;

      await this.persistOrder(order);

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

    // Cancel the original order
    const result = await this.cancelOrderInternal(orderId, order);

    // Also cancel the complementary order if it exists
    if (order.complementaryOrderId && !order.isComplementary) {
      const complementaryOrder = await this.getOrder(order.complementaryOrderId);
      if (complementaryOrder) {
        await this.cancelOrderInternal(order.complementaryOrderId, complementaryOrder);
      }
    }

    return result;
  }

  private async cancelOrderInternal(orderId: string, order: Order): Promise<boolean> {

    const multi = redis.multi();

    // Update status
    const updatedAt = Date.now();

    multi.hSet(`order:${orderId}`, {
      status: OrderStatus.CANCELLED.toString(),
      updatedAt: updatedAt.toString(),
    });

    // Remove from orderbook
    const bookPositionId = this.getBookPositionId(
      order.side,
      order.makerPositionId,
      order.takerPositionId
    );
    const bookKey = this.buildOrderbookKey(
      order.marketId,
      bookPositionId,
      order.side
    );
    multi.zRem(bookKey, orderId);

    await multi.exec();

    await this.clearOrderbookCache(order.marketId, bookPositionId);

    order.status = OrderStatus.CANCELLED;
    order.updatedAt = updatedAt;

    await this.persistOrder(order);

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

    const updatedAt = Date.now();

    // Update status
    multi.hSet(`order:${orderId}`, {
      status: OrderStatus.EXPIRED.toString(),
      updatedAt: updatedAt.toString(),
    });

    // Remove from orderbook
    const bookPositionId = this.getBookPositionId(
      order.side,
      order.makerPositionId,
      order.takerPositionId
    );
    const bookKey = this.buildOrderbookKey(
      order.marketId,
      bookPositionId,
      order.side
    );
    multi.zRem(bookKey, orderId);

    await multi.exec();

    await this.clearOrderbookCache(order.marketId, bookPositionId);

    order.status = OrderStatus.EXPIRED;
    order.updatedAt = updatedAt;

    await this.persistOrder(order);

    console.log(`⏰ Order expired: ${orderId}`);
    return true;
  }

  // ========== ORDERBOOK MANAGEMENT ==========

  /**
   * Get orderbook snapshot - aggregates orders by price level
   *
   * Used by: /api/orderbook endpoint (user-facing API for frontend)
   * NOT used by: matching engine (it calculates bestBid/bestAsk from sorted orders directly)
   *
   * Performance optimization:
   * - 10-second cache reduces API response time (orderbooks don't change every second)
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
    positionId: string
  ): Promise<{ bids: OrderbookLevel[]; asks: OrderbookLevel[] }> {
    // Check 10s cache first (helps API performance when frontend polls frequently)
    const cacheKey = `orderbook:${marketId}:${positionId}:cache`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached); // Parse JSON from Redis
    }

    // Build from sorted sets
    const [bidsRaw, asksRaw] = await Promise.all([
      redis.zRangeWithScores(`orderbook:${marketId}:${positionId}:buy`, 0, -1, {
        REV: true,
      }),
      redis.zRangeWithScores(`orderbook:${marketId}:${positionId}:sell`, 0, -1),
    ]);

    // Parse and aggregate by price level
    const bids = await this.aggregateOrderbook(bidsRaw, true, positionId);
    const asks = await this.aggregateOrderbook(asksRaw, false, positionId);

    const result = { bids, asks };

    // Cache for 10 seconds
    await redis.setEx(cacheKey, 10, JSON.stringify(result));

    return result;
  }

  private async aggregateOrderbook(
    rawData: Array<{ score: number; value: string }>,
    isBid: boolean,
    positionId: string
  ): Promise<OrderbookLevel[]> {
    const levels = new Map<number, { size: number; count: number }>();

    // rawData format: array of {score: price, value: orderId}
    for (const item of rawData) {
      const orderId = item.value;
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

      if (
        (isBid && order.takerPositionId !== positionId) ||
        (!isBid && order.makerPositionId !== positionId)
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
    await this.writeMarketToRedis(market);
    await this.persistMarket(market);

    console.log(`📊 New market: ${market.marketId} - "${market.question}"`);
  }

  // ========== HELPERS ==========

  private getBookPositionId(
    side: OrderSide,
    makerPositionId: string,
    takerPositionId: string
  ): string {
    return side === OrderSide.BUY ? takerPositionId : makerPositionId;
  }

  private buildOrderbookKey(
    marketId: string,
    positionId: string,
    side: OrderSide
  ): string {
    return `orderbook:${marketId}:${positionId}:${side.toLowerCase()}`;
  }

  private async clearOrderbookCache(
    marketId: string,
    positionId: string
  ): Promise<void> {
    await redis.del(`orderbook:${marketId}:${positionId}:cache`);
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

  async updateMarketPrices(
    marketId: string,
    yesPrice: number,
    noPrice: number
  ): Promise<void> {
    const exists = await redis.exists(`market:${marketId}`);
    if (!exists) {
      return;
    }

    await redis.hSet(`market:${marketId}`, {
      yesPrice: yesPrice.toString(),
      noPrice: noPrice.toString(),
    });

    await this.persistenceSafeCall(async () => {
      await this.persistence?.updateMarketPrices(marketId, yesPrice, noPrice);
    }, "updateMarketPrices");
  }

  // ========== HELPERS ==========

  async restoreFromPersistence(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    await this.persistenceSafeCall(async () => {
      const markets = await this.persistence!.getAllMarkets();
      for (const market of markets) {
        await this.writeMarketToRedis(market);
      }

      const orders = await this.persistence!.getAllOrders();
      for (const order of orders) {
        await this.writeOrderToRedis(order);
      }

      if (markets.length > 0 || orders.length > 0) {
        console.log(
          `💾 Restored ${markets.length} markets and ${orders.length} orders from Postgres`
        );
      }
    }, "restoreFromPersistence");
  }

  private async writeOrderToRedis(order: Order): Promise<void> {
    const multi = redis.multi();
    const orderHash: Record<string, string> = {};

    for (const [key, value] of Object.entries(order)) {
      if (value !== undefined) {
        orderHash[key] = String(value);
      }
    }

    multi.hSet(`order:${order.orderId}`, orderHash);
    multi.sAdd(`market:${order.marketId}:orders`, order.orderId);
    multi.sAdd(`user:${order.maker}:orders`, order.orderId);

    const bookPositionId = this.getBookPositionId(
      order.side,
      order.makerPositionId,
      order.takerPositionId
    );
    const bookKey = this.buildOrderbookKey(
      order.marketId,
      bookPositionId,
      order.side
    );

    if (this.orderRestingInBook(order.status)) {
      multi.zAdd(bookKey, { score: order.price, value: order.orderId });
    } else {
      multi.zRem(bookKey, order.orderId);
    }

    await multi.exec();

    await this.clearOrderbookCache(order.marketId, bookPositionId);
  }

  private orderRestingInBook(status: OrderStatus): boolean {
    return (
      status === OrderStatus.OPEN || status === OrderStatus.PARTIALLY_FILLED
    );
  }

  private async writeMarketToRedis(market: Market): Promise<void> {
    const multi = redis.multi();
    const marketHash: Record<string, string> = {};

    for (const [key, value] of Object.entries(market)) {
      if (value !== undefined) {
        marketHash[key] = String(value);
      }
    }

    multi.hSet(`market:${market.marketId}`, marketHash);
    multi.sAdd("markets", market.marketId);
    await multi.exec();
  }

  private async persistOrder(order: Order): Promise<void> {
    await this.persistenceSafeCall(async () => {
      await this.persistence?.upsertOrder(order);
    }, "upsertOrder");
  }

  private async persistMarket(market: Market): Promise<void> {
    await this.persistenceSafeCall(async () => {
      await this.persistence?.upsertMarket(market);
    }, "upsertMarket");
  }

  private async persistenceSafeCall(
    action: () => Promise<void>,
    context: string
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      console.error(`⚠️  Postgres persistence error (${context}):`, error);
    }
  }

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
      complementaryOrderId: data.complementaryOrderId || undefined,
      isComplementary:
        data.isComplementary !== undefined
          ? data.isComplementary === "true"
          : false,
    };
  }
}
