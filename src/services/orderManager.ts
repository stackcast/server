import {
  Order,
  OrderSide,
  OrderStatus,
  OrderbookLevel,
  Market,
} from "../types/order";
import { randomBytes } from "crypto";

export class OrderManager {
  private orders: Map<string, Order> = new Map();
  private marketOrders: Map<string, Set<string>> = new Map(); // marketId -> orderIds
  private userOrders: Map<string, Set<string>> = new Map(); // user address -> orderIds
  private markets: Map<string, Market> = new Map();

  // Add a new order

  addOrder(
    order: Omit<
      Order,
      | "orderId"
      | "filledSize"
      | "remainingSize"
      | "status"
      | "createdAt"
      | "updatedAt"
    >
  ): Order {
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

    this.orders.set(orderId, fullOrder);

    // Index by market
    if (!this.marketOrders.has(order.marketId)) {
      this.marketOrders.set(order.marketId, new Set());
    }
    this.marketOrders.get(order.marketId)!.add(orderId);

    // Index by user
    if (!this.userOrders.has(order.maker)) {
      this.userOrders.set(order.maker, new Set());
    }
    this.userOrders.get(order.maker)!.add(orderId);

    console.log(
      `📝 New order: ${orderId} - ${order.side} ${order.size} @ ${order.price}`
    );
    return fullOrder;
  }

  // Get order by ID
  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  // Get all orders for a market
  getMarketOrders(marketId: string): Order[] {
    const orderIds = this.marketOrders.get(marketId);
    if (!orderIds) return [];

    return Array.from(orderIds)
      .map((id) => this.orders.get(id))
      .filter((order): order is Order => order !== undefined);
  }

  // Get user's orders
  getUserOrders(userAddress: string): Order[] {
    const orderIds = this.userOrders.get(userAddress);
    if (!orderIds) return [];

    return Array.from(orderIds)
      .map((id) => this.orders.get(id))
      .filter((order): order is Order => order !== undefined);
  }

  // Update order fill
  fillOrder(orderId: string, fillSize: number): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;

    order.filledSize += fillSize;
    order.remainingSize -= fillSize;
    order.updatedAt = Date.now();

    if (order.remainingSize <= 0) {
      order.status = OrderStatus.FILLED;
      console.log(`✅ Order filled: ${orderId}`);
    } else {
      order.status = OrderStatus.PARTIALLY_FILLED;
      console.log(
        `⚡ Order partially filled: ${orderId} (${order.filledSize}/${order.size})`
      );
    }

    return true;
  }

  // Cancel order
  cancelOrder(orderId: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;

    if (
      order.status === OrderStatus.FILLED ||
      order.status === OrderStatus.CANCELLED
    ) {
      return false;
    }

    order.status = OrderStatus.CANCELLED;
    order.updatedAt = Date.now();
    console.log(`❌ Order cancelled: ${orderId}`);
    return true;
  }

  // Generate orderbook for a market
  getOrderbook(
    marketId: string,
    positionId: string
  ): { bids: OrderbookLevel[]; asks: OrderbookLevel[] } {
    const restingOrders = this.getMarketOrders(marketId).filter(
      (order) =>
        (order.status === OrderStatus.OPEN ||
          order.status === OrderStatus.PARTIALLY_FILLED)
    );

    const bids = this.aggregateOrders(
      restingOrders.filter(
        (order) =>
          order.side === OrderSide.BUY &&
          order.takerPositionId === positionId
      ),
      true
    );

    const asks = this.aggregateOrders(
      restingOrders.filter(
        (order) =>
          order.side === OrderSide.SELL &&
          order.makerPositionId === positionId
      ),
      false
    );

    return { bids, asks };
  }

  private aggregateOrders(orders: Order[], isBid: boolean): OrderbookLevel[] {
    const levels = new Map<number, { size: number; count: number }>();

    for (const order of orders) {
      const existing = levels.get(order.price) || { size: 0, count: 0 };
      existing.size += order.remainingSize;
      existing.count += 1;
      levels.set(order.price, existing);
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

  // Market management
  addMarket(market: Market): void {
    this.markets.set(market.marketId, market);
    console.log(`📊 New market: ${market.marketId} - "${market.question}"`);
  }

  getMarket(marketId: string): Market | undefined {
    return this.markets.get(marketId);
  }

  getAllMarkets(): Market[] {
    return Array.from(this.markets.values());
  }

  // Stats
  getOrderCount(): number {
    return this.orders.size;
  }

  private generateOrderId(): string {
    return `order_${Date.now()}_${randomBytes(8).toString("hex")}`;
  }
}
