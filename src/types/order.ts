export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL'
}

export enum OrderStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED'
}

export interface Order {
  orderId: string;
  maker: string; // Principal address
  marketId: string;
  conditionId: string;
  makerPositionId: string; // Maker's position ID (what they're selling)
  takerPositionId: string; // Taker's position ID (what they're buying)
  side: OrderSide;
  price: number; // In cents (e.g., 66 = $0.66)
  size: number; // Token amount
  filledSize: number;
  remainingSize: number;
  status: OrderStatus;
  salt: string;
  expiration: number; // Block height
  createdAt: number;
  updatedAt: number;
  signature?: string;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  orderCount: number;
}

export interface Orderbook {
  marketId: string;
  conditionId: string;
  bids: OrderbookLevel[]; // Buy orders (sorted high to low)
  asks: OrderbookLevel[]; // Sell orders (sorted low to high)
  lastUpdated: number;
}

export interface Trade {
  tradeId: string;
  marketId: string;
  conditionId: string;
  positionId: string;
  maker: string;
  taker: string;
  price: number;
  size: number;
  side: OrderSide; // From taker's perspective
  makerOrderId: string;
  takerOrderId: string;
  timestamp: number;
  txHash?: string; // Stacks transaction hash after settlement
}

export interface Market {
  marketId: string;
  conditionId: string;
  question: string;
  creator: string;
  yesPositionId: string;
  noPositionId: string;
  yesPrice: number; // Last trade price or mid-price
  noPrice: number;
  volume24h: number;
  createdAt: number;
  resolved: boolean;
  outcome?: number; // 0 = NO, 1 = YES
}
