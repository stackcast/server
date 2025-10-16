import { Market, Order, OrderSide, OrderStatus, Trade, TradeType } from '../types/order';
import { OrderManagerRedis } from './orderManagerRedis';
import { StacksSettlementService } from './stacksSettlement';
import { randomBytes } from 'crypto';

/**
 * Matching Engine - Continuous order matching with price-time priority
 *
 * How it works:
 * 1. Runs every 100ms in a loop (start() method)
 * 2. For each market + position, sorts orders by price
 * 3. Matches when buy price >= sell price
 * 4. Executes at maker's price (maker = first in book)
 * 5. Submits trades to settlement service for on-chain execution
 *
 * Matching algorithm (price-time priority):
 * - Orders sorted by: best price first, then earliest timestamp
 * - BUY orders: highest price wins (willing to pay more)
 * - SELL orders: lowest price wins (willing to accept less)
 * - When prices cross (buy >= sell): match and execute
 *
 * Example:
 * Orderbook:
 *   Bids: [68¢×100, 66¢×200]
 *   Asks: [70¢×150, 72¢×300]
 * New order: BUY 50 @ 71¢
 * → Matches with best ask (70¢×150), executes 50 @ 70¢
 * → Buyer gets better price (wanted 71¢, got 70¢)
 */
export class MatchingEngine {
  private orderManager: OrderManagerRedis;
  private running: boolean = false;
  private matchInterval: Timer | null = null;
  private trades: Map<string, Trade> = new Map();
  private settlementService?: StacksSettlementService;
  private isMatching = false;

  constructor(orderManager: OrderManagerRedis, settlementService?: StacksSettlementService) {
    this.orderManager = orderManager;
    this.settlementService = settlementService;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    console.log('🎯 Matching engine started');

    // Run matching every 100ms
    this.matchInterval = setInterval(async () => {
      if (this.isMatching) {
        return;
      }

      this.isMatching = true;

      try {
        await this.matchAllMarkets();
      } catch (err) {
        console.error('❌ Matching error:', err);
      } finally {
        this.isMatching = false;
      }
    }, 100);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.matchInterval) {
      clearInterval(this.matchInterval);
      this.matchInterval = null;
    }
    this.isMatching = false;
    console.log('⏸️  Matching engine stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // Match all markets
  private async matchAllMarkets(): Promise<void> {
    const markets = await this.orderManager.getAllMarkets();

    const matchTasks = markets
      .filter(market => !market.resolved)
      .flatMap(market => [
        this.matchMarket(market, market.yesPositionId),
        this.matchMarket(market, market.noPositionId),
      ]);

    if (matchTasks.length === 0) {
      return;
    }

    await Promise.all(matchTasks);
  }

  /**
   * Match orders for a specific market and position token
   *
   * Algorithm (price-time priority):
   * 1. Load all OPEN/PARTIALLY_FILLED orders for this position
   * 2. Sort BUY orders: high→low price, then FIFO (earliest first)
   * 3. Sort SELL orders: low→high price, then FIFO
   * 4. Walk through both sorted lists:
   *    - If buyPrice >= sellPrice: match at sell price (maker's price)
   *    - Fill min(buySize, sellSize)
   *    - Move to next order when one is fully filled
   *
   * Example:
   * Bids (sorted): [70¢×100 (new), 68¢×200 (old)]
   * Asks (sorted): [65¢×150 (old), 67¢×300 (new)]
   *
   * Match 1: 70¢×100 vs 65¢×150 → execute 100 @ 65¢
   *   - Buyer wanted 70¢, got 65¢ (saved 5¢)
   *   - Seller wanted 65¢, got 65¢ (fair)
   *   - Buyer order FILLED, seller has 50 remaining
   *
   * Match 2: 68¢×200 vs 65¢×50 → execute 50 @ 65¢
   *   - Seller order FILLED, buyer has 150 remaining
   *
   * Match 3: 68¢×150 vs 67¢×300 → execute 150 @ 67¢
   *   - Buyer order FILLED, seller has 150 remaining
   *
   * Final state: All bids filled, asks have 150 @ 67¢ remaining
   */
  private async matchMarket(market: Market, positionId: string): Promise<void> {
    // Get all active orders for this market and outcome
    const orders = (await this.orderManager.getMarketOrders(market.marketId)).filter(
      (order) =>
        (order.status === OrderStatus.OPEN ||
          order.status === OrderStatus.PARTIALLY_FILLED) &&
        ((order.side === OrderSide.BUY && order.takerPositionId === positionId) ||
          (order.side === OrderSide.SELL && order.makerPositionId === positionId))
    );

    // Sort by price-time priority
    const buyOrders = orders
      .filter((order) => order.side === OrderSide.BUY)
      .sort((a, b) => b.price - a.price || a.createdAt - b.createdAt); // High→low, FIFO

    const sellOrders = orders
      .filter((order) => order.side === OrderSide.SELL)
      .sort((a, b) => a.price - b.price || a.createdAt - b.createdAt); // Low→high, FIFO

    // Two-pointer matching algorithm
    let buyIndex = 0;
    let sellIndex = 0;

    while (buyIndex < buyOrders.length && sellIndex < sellOrders.length) {
      const buyOrder = buyOrders[buyIndex];
      const sellOrder = sellOrders[sellIndex];

      // Check if prices cross (necessary condition for match)
      if (buyOrder.price < sellOrder.price) {
        break; // No more matches possible (spread is positive)
      }

      // Calculate how much to fill (limited by smaller order)
      const matchSize = Math.min(buyOrder.remainingSize, sellOrder.remainingSize);

      // Execute at maker's price (sell order arrived first, gets their price)
      const matchPrice = sellOrder.price;

      // Detect if this is a complementary trade (MINT opportunity)
      // BUY YES + SELL NO at same market = can mint sets instead of swap
      const isComplementaryTrade = this.detectComplementaryTrade(buyOrder, sellOrder);
      const tradeType = isComplementaryTrade ? TradeType.MINT : TradeType.NORMAL;

      // Create trade
      const trade = this.createTrade({
        marketId: market.marketId,
        conditionId: buyOrder.conditionId,
        makerPositionId: sellOrder.makerPositionId,
        takerPositionId: sellOrder.takerPositionId,
        maker: sellOrder.maker,
        taker: buyOrder.maker,
        price: matchPrice,
        size: matchSize,
        side: OrderSide.BUY, // Taker's side
        makerOrderId: sellOrder.orderId,
        takerOrderId: buyOrder.orderId,
        tradeType,
      });

      this.trades.set(trade.tradeId, trade);

      // Update orders (await both fills)
      await Promise.all([
        this.orderManager.fillOrder(buyOrder.orderId, matchSize),
        this.orderManager.fillOrder(sellOrder.orderId, matchSize)
      ]);

      this.updateOrderState(buyOrder, matchSize);
      this.updateOrderState(sellOrder, matchSize);

      console.log(
        `🔄 MATCH: ${matchSize} @ ${matchPrice} (${buyOrder.orderId} ↔️ ${sellOrder.orderId})`
      );

      if (this.settlementService?.isEnabled()) {
        try {
          const txId = await this.settlementService.submitFill({
            trade,
            makerOrder: sellOrder,
            takerOrder: buyOrder,
            fillAmount: matchSize,
            executionPrice: matchPrice,
          });

          if (txId) {
            const settledTrade: Trade = { ...trade, txHash: txId };
            this.trades.set(trade.tradeId, settledTrade);
          }
        } catch (error) {
          console.error('❌ Settlement broadcast failed:', error);
        }
      }

      // Move to next order if filled
      if (buyOrder.remainingSize <= 0) buyIndex++;
      if (sellOrder.remainingSize <= 0) sellIndex++;
    }
  }

  private createTrade(params: Omit<Trade, 'tradeId' | 'timestamp'>): Trade {
    return {
      ...params,
      tradeId: `trade_${Date.now()}_${randomBytes(8).toString('hex')}`,
      timestamp: Date.now()
    };
  }

  private updateOrderState(order: Order, matchSize: number): void {
    order.remainingSize = Math.max(0, order.remainingSize - matchSize);
    order.filledSize += matchSize;
    order.status =
      order.remainingSize === 0 ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;
  }

  // Get recent trades
  getTrades(marketId?: string, limit: number = 50): Trade[] {
    let trades = Array.from(this.trades.values());

    if (marketId) {
      trades = trades.filter(t => t.marketId === marketId);
    }

    return trades
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  // Get trade by ID
  getTrade(tradeId: string): Trade | undefined {
    return this.trades.get(tradeId);
  }

  /**
   * Detect if two orders are complementary (can use MINT mode)
   *
   * Complementary = BUY YES + SELL NO (or BUY NO + SELL YES)
   * at prices that sum to 100¢
   *
   * Example:
   * - Order A: BUY YES @ 66¢
   * - Order B: SELL NO @ 34¢
   * → These are complementary! Can mint sets instead of swap
   *
   * Benefits of MINT mode:
   * - More gas efficient (no token transfers needed)
   * - Cleaner user experience
   * - Matches Polymarket's exchange behavior
   */
  private detectComplementaryTrade(buyOrder: Order, sellOrder: Order): boolean {
    // Check if they're trading opposite outcomes
    const buyingYES = buyOrder.takerPositionId; // What buyer wants
    const sellingNO = sellOrder.makerPositionId; // What seller gives

    // Complementary if:
    // 1. Buyer wants YES and seller gives NO (or vice versa)
    // 2. Prices sum to ~100 (within 1¢ tolerance for floating point)
    const isOppositeOutcomes = buyingYES !== sellingNO;
    const priceSum = buyOrder.price + sellOrder.price;
    const pricesSumTo100 = Math.abs(priceSum - 100) < 1;

    return isOppositeOutcomes && pricesSumTo100;
  }
}
