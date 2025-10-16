// Order direction: BUY = acquiring outcome tokens, SELL = selling outcome tokens
// Example: BUY YES = spend NO tokens to get YES tokens
export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL'
}

// Order lifecycle: OPEN → PARTIALLY_FILLED → FILLED (or CANCELLED/EXPIRED)
export enum OrderStatus {
  PENDING = 'PENDING',      // Initial state (rarely used)
  OPEN = 'OPEN',            // Active in orderbook, awaiting match
  PARTIALLY_FILLED = 'PARTIALLY_FILLED', // Some filled, still in book
  FILLED = 'FILLED',        // Completely filled, removed from book
  CANCELLED = 'CANCELLED',  // User cancelled, removed from book
  EXPIRED = 'EXPIRED'       // Past expiration block height, removed
}

// Core order structure - signed commitment to trade outcome tokens
//
// How it works:
// 1. User signs order hash (maker + positions + amounts + salt + expiration)
// 2. Server validates signature and stores in Redis orderbook
// 3. Matching engine pairs BUY/SELL orders (buy price >= sell price)
// 4. Settlement service submits matched trades to ctf-exchange.clar
//
// Example: BUY 100 YES @ 66¢
//   - Maker provides: 100 NO tokens (worth 34¢ each = 3400¢)
//   - Maker receives: 100 YES tokens (worth 66¢ each = 6600¢)
//   - Price represents probability: 66% chance YES wins
export interface Order {
  orderId: string;          // Unique: "order_{timestamp}_{random16}"
  maker: string;            // Stacks principal (e.g., SP2ABC...)
  marketId: string;         // Market identifier
  conditionId: string;      // Links to conditional-tokens.clar condition
  makerPositionId: string;  // What maker gives (32-byte hex: YES or NO token)
  takerPositionId: string;  // What maker gets (32-byte hex: YES or NO token)
  side: OrderSide;          // BUY or SELL from maker's perspective
  price: number;            // Cents: 0-100 (e.g., 66 = $0.66 = 66% probability)
  size: number;             // Token amount (e.g., 100 tokens)
  filledSize: number;       // Amount matched so far
  remainingSize: number;    // size - filledSize
  status: OrderStatus;      // Current lifecycle state
  salt: string;             // Random nonce for unique order hashes
  expiration: number;       // Stacks block height (expires when chain passes this)
  createdAt: number;        // Unix ms timestamp
  updatedAt: number;        // Unix ms timestamp (updated on fills)
  signature?: string;       // 65-byte ECDSA sig (130 hex chars)
  publicKey?: string;       // Compressed public key for signature verification
}

// Aggregated orderbook price level showing total liquidity
// Example: { price: 66, size: 500, orderCount: 3 }
//   → 500 tokens available at 66¢ from 3 different orders
export interface OrderbookLevel {
  price: number;       // Price in cents (0-100)
  size: number;        // Total size from all orders at this price
  orderCount: number;  // How many orders contribute to this level
}

// Live orderbook snapshot for one outcome token (YES or NO)
// Bids = buy orders, Asks = sell orders (standard market terminology)
export interface Orderbook {
  marketId: string;
  conditionId: string;
  bids: OrderbookLevel[];  // Buy orders: high to low (best bid = highest price)
  asks: OrderbookLevel[];  // Sell orders: low to high (best ask = lowest price)
  lastUpdated: number;     // Unix ms timestamp
}

// Executed trade - created when matching engine pairs buy/sell orders
//
// Execution price: Always uses maker's price (price-time priority)
// Example: Sell order @ 60¢ rests in book, Buy order @ 65¢ arrives
//   → Trade executes at 60¢ (maker's price), buyer gets better deal
export interface Trade {
  tradeId: string;          // Unique: "trade_{timestamp}_{random16}"
  marketId: string;
  conditionId: string;
  makerPositionId: string;  // Position maker sold (YES or NO)
  takerPositionId: string;  // Position taker bought (YES or NO)
  maker: string;            // Resting order (was in book first)
  taker: string;            // Incoming order (crossed the spread)
  price: number;            // Execution price (always maker's price)
  size: number;             // Amount traded
  side: OrderSide;          // From taker's perspective (BUY or SELL)
  makerOrderId: string;     // Resting order ID
  takerOrderId: string;     // Incoming order ID
  timestamp: number;        // Unix ms timestamp
  txHash?: string;          // Stacks txid after on-chain settlement
}

// Prediction market metadata and current pricing
//
// YES + NO prices always sum to 100 (complementary probabilities)
// Example: yesPrice=66, noPrice=34 → market thinks 66% chance YES wins
export interface Market {
  marketId: string;
  conditionId: string;      // Links to conditional-tokens.clar
  question: string;         // "Will BTC hit $100k by Dec 31, 2025?"
  creator: string;          // Market creator's Stacks principal
  yesPositionId: string;    // 32-byte hex token ID for YES outcome
  noPositionId: string;     // 32-byte hex token ID for NO outcome
  yesPrice: number;         // Current YES price (cents, 0-100)
  noPrice: number;          // Current NO price = 100 - yesPrice
  volume24h: number;        // 24h trading volume
  createdAt: number;        // Unix ms timestamp
  resolved: boolean;        // True after oracle resolves condition
  outcome?: number;         // Final result: 0=NO wins, 1=YES wins
}

// Order types for smart routing
export enum OrderType {
  LIMIT = "LIMIT",   // Rests in book at specified price, may not fill immediately
  MARKET = "MARKET", // Fills immediately at best available prices (multi-level)
}

// Smart order request - user-friendly order placement
//
// Smart router handles position ID logic based on outcome + side:
// - BUY YES: give NO tokens, get YES tokens
// - SELL YES: give YES tokens, get NO tokens
// - BUY NO: give YES tokens, get NO tokens
// - SELL NO: give NO tokens, get YES tokens
export interface SmartOrderRequest {
  maker: string;
  marketId: string;
  outcome: "yes" | "no";    // Which outcome to trade (human-friendly)
  side: OrderSide;          // BUY or SELL that outcome
  orderType: OrderType;     // LIMIT or MARKET
  size: number;             // Token amount
  price?: number;           // Required for LIMIT orders (cents, 0-100)
  maxSlippage?: number;     // MARKET only: max % slippage allowed (default 5%)
  salt?: string;            // Order uniqueness nonce
  expiration?: number;      // Stacks block height expiration
  signature?: string;       // ECDSA signature (130 hex chars)
  publicKey?: string;       // Compressed public key for verification
}
