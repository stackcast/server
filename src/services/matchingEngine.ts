import { Order, OrderSide, OrderStatus, Trade } from '../types/order';
import { OrderManagerRedis } from './orderManagerRedis';
import { StacksSettlementService } from './stacksSettlement';
import { randomBytes } from 'crypto';

export class MatchingEngine {
  private orderManager: OrderManagerRedis;
  private running: boolean = false;
  private matchInterval: Timer | null = null;
  private trades: Map<string, Trade> = new Map();
  private settlementService?: StacksSettlementService;

  constructor(orderManager: OrderManagerRedis, settlementService?: StacksSettlementService) {
    this.orderManager = orderManager;
    this.settlementService = settlementService;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    console.log('🎯 Matching engine started');

    // Run matching every 100ms
    this.matchInterval = setInterval(() => {
      this.matchAllMarkets().catch(err => {
        console.error('❌ Matching error:', err);
      });
    }, 100);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.matchInterval) {
      clearInterval(this.matchInterval);
      this.matchInterval = null;
    }
    console.log('⏸️  Matching engine stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // Match all markets
  private async matchAllMarkets(): Promise<void> {
    const markets = await this.orderManager.getAllMarkets();

    for (const market of markets) {
      if (market.resolved) continue;

      // Match YES position
      await this.matchMarket(market.marketId, market.yesPositionId);
      // Match NO position
      await this.matchMarket(market.marketId, market.noPositionId);
    }
  }

  // Match a specific market/position
  private async matchMarket(marketId: string, positionId: string): Promise<void> {
    const orders = (await this.orderManager.getMarketOrders(marketId))
      .filter(o => o.positionId === positionId &&
                   (o.status === OrderStatus.OPEN || o.status === OrderStatus.PARTIALLY_FILLED));

    // Separate into buy and sell orders
    const buyOrders = orders.filter(o => o.side === OrderSide.BUY)
      .sort((a, b) => b.price - a.price || a.createdAt - b.createdAt); // High to low, then FIFO

    const sellOrders = orders.filter(o => o.side === OrderSide.SELL)
      .sort((a, b) => a.price - b.price || a.createdAt - b.createdAt); // Low to high, then FIFO

    // Match orders
    let buyIndex = 0;
    let sellIndex = 0;

    while (buyIndex < buyOrders.length && sellIndex < sellOrders.length) {
      const buyOrder = buyOrders[buyIndex];
      const sellOrder = sellOrders[sellIndex];

      // Check if orders can match (buy price >= sell price)
      if (buyOrder.price < sellOrder.price) {
        break; // No more matches possible
      }

      // Calculate match size
      const matchSize = Math.min(buyOrder.remainingSize, sellOrder.remainingSize);

      // Use sell order's price (maker gets better price)
      const matchPrice = sellOrder.price;

      // Create trade
      const trade = this.createTrade({
        marketId,
        conditionId: buyOrder.conditionId,
        positionId,
        maker: sellOrder.maker,
        taker: buyOrder.maker,
        price: matchPrice,
        size: matchSize,
        side: OrderSide.BUY, // Taker's side
        makerOrderId: sellOrder.orderId,
        takerOrderId: buyOrder.orderId
      });

      this.trades.set(trade.tradeId, trade);

      // Update orders (await both fills)
      await Promise.all([
        this.orderManager.fillOrder(buyOrder.orderId, matchSize),
        this.orderManager.fillOrder(sellOrder.orderId, matchSize)
      ]);

      console.log(`🔄 MATCH: ${matchSize} @ ${matchPrice} (${buyOrder.orderId} ↔️ ${sellOrder.orderId})`);

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
}
