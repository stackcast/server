import { Market, Order, OrderSide, OrderStatus, Trade, TradeType } from '../types/order';
import { OrderManagerRedis } from './orderManagerRedis';
import { StacksSettlementService } from './stacksSettlement';
import { randomBytes } from 'crypto';
import { deriveYesNoPrices, PRICE_SCALE } from '../utils/pricing';

/**
 * Matching Engine - Continuous order matching with price-time priority
 *
 * How it works:
 * 1. Runs every 100ms in a loop (start() method)
 * 2. Fetches ALL orders from Redis for each market + position
 * 3. Sorts orders by price-time priority in memory (temporary)
 * 4. Matches when buy price >= sell price
 * 5. Executes at maker's price (maker = first in book)
 * 6. Updates market prices using bestBid/bestAsk from sorted arrays (NO cache hit)
 * 7. Submits trades to settlement service for on-chain execution
 * 8. Discards in-memory order list (re-fetch next cycle to get new orders)
 *
 * Matching algorithm (price-time priority):
 * - Orders sorted by: best price first, then earliest timestamp
 * - BUY orders: highest price wins (willing to pay more)
 * - SELL orders: lowest price wins (willing to accept less)
 * - When prices cross (buy >= sell): match and execute
 *
 * Performance:
 * - Each cycle: 1 Redis fetch per market (getMarketOrders)
 * - Best bid/ask calculated from sorted arrays (no redundant orderbook fetch)
 * - New orders submitted during cycle picked up in next 100ms cycle
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
    let lastTradePriceForPosition: number | undefined;

    // Track best bid/ask for price update (avoid redundant orderbook fetch)
    let bestBid: number | undefined;
    let bestAsk: number | undefined;

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

      // Detect trade type: MINT (both BUY), MERGE (both SELL), or NORMAL (BUY+SELL)
      let tradeType = TradeType.NORMAL;
      if (this.detectComplementaryTrade(buyOrder, sellOrder)) {
        // Both are BUY → MINT
        if (buyOrder.side === OrderSide.BUY && sellOrder.side === OrderSide.BUY) {
          tradeType = TradeType.MINT;
        }
        // Both are SELL → MERGE
        else if (buyOrder.side === OrderSide.SELL && sellOrder.side === OrderSide.SELL) {
          tradeType = TradeType.MERGE;
        }
      }

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

      lastTradePriceForPosition = matchPrice;

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

    // Calculate best bid/ask from sorted orders (no need to re-fetch orderbook)
    // Best bid = highest buy order still open
    for (const order of buyOrders) {
      if (order.remainingSize > 0) {
        bestBid = order.price;
        break;
      }
    }

    // Best ask = lowest sell order still open
    for (const order of sellOrders) {
      if (order.remainingSize > 0) {
        bestAsk = order.price;
        break;
      }
    }

    await this.refreshMarketPrices(
      market,
      positionId,
      lastTradePriceForPosition,
      bestBid,
      bestAsk
    );
  }

  private async refreshMarketPrices(
    market: Market,
    positionId: string,
    lastTradePrice?: number,
    bestBid?: number,
    bestAsk?: number
  ): Promise<void> {
    try {
      // bestBid/bestAsk now passed from matchMarket() - no need to fetch orderbook again!

      let effectiveLastTrade: number | undefined;
      if (typeof lastTradePrice === 'number') {
        effectiveLastTrade =
          positionId === market.yesPositionId
            ? lastTradePrice
            : Math.max(0, PRICE_SCALE - lastTradePrice);
      }

      const { yesPrice, noPrice } = deriveYesNoPrices({
        bestBid,
        bestAsk,
        lastTradePrice: effectiveLastTrade,
        currentYesPrice: market.yesPrice,
      });

      await this.orderManager.updateMarketPrices(
        market.marketId,
        yesPrice,
        noPrice
      );

      market.yesPrice = yesPrice;
      market.noPrice = noPrice;
    } catch (error) {
      console.error(
        `Failed to refresh market prices for ${market.marketId}:`,
        error
      );
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

  recordTradeSettlement(tradeId: string, txHash: string): void {
    const trade = this.trades.get(tradeId);
    if (trade) {
      this.trades.set(tradeId, { ...trade, txHash });
    }
  }

  /**
   * Detect trade type based on order sides and outcomes
   *
   * Three types of matches:
   *
   * 1. MINT: Both BUY orders for opposite outcomes (BUY YES + BUY NO)
   *    - Prices sum to ~100¢ (e.g., 60¢ + 40¢)
   *    - Exchange takes sBTC from both buyers
   *    - Calls split-position to mint YES+NO tokens
   *    - Gives each buyer their desired outcome
   *
   * 2. MERGE: Both SELL orders for opposite outcomes (SELL YES + SELL NO)
   *    - Prices sum to ~100¢ (e.g., 35¢ + 65¢)
   *    - Exchange takes YES+NO tokens from both sellers
   *    - Calls merge-positions to burn and recover sBTC
   *    - Gives each seller their share of sBTC
   *
   * 3. NORMAL: BUY + SELL for same outcome (traditional swap)
   *    - Buyer sends sBTC to seller
   *    - Seller sends outcome tokens to buyer
   */
  private detectComplementaryTrade(buyOrder: Order, sellOrder: Order): boolean {
    // MINT mode: Both are BUY orders for opposite outcomes
    if (buyOrder.side === OrderSide.BUY && sellOrder.side === OrderSide.BUY) {
      const buyingDifferentOutcomes = buyOrder.takerPositionId !== sellOrder.takerPositionId;
      const priceSum = buyOrder.price + sellOrder.price;
      const pricesSumTo100 = Math.abs(priceSum - 1_000_000) < 10_000; // Within 0.01 sBTC tolerance

      return buyingDifferentOutcomes && pricesSumTo100;
    }

    // MERGE mode: Both are SELL orders for opposite outcomes
    if (buyOrder.side === OrderSide.SELL && sellOrder.side === OrderSide.SELL) {
      const sellingDifferentOutcomes = buyOrder.makerPositionId !== sellOrder.makerPositionId;
      const priceSum = buyOrder.price + sellOrder.price;
      const pricesSumTo100 = Math.abs(priceSum - 1_000_000) < 10_000;

      return sellingDifferentOutcomes && pricesSumTo100;
    }

    return false;
  }
}
