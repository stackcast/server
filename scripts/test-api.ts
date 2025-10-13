#!/usr/bin/env bun

/**
 * Simple test script to demonstrate the API
 * Run: bun scripts/test-api.ts
 *
 * NOTE: This script places orders without signatures (optional for testing).
 * In production, the frontend will include:
 * - signature: Stacks wallet signature of the order hash
 * - publicKey: The public key from the wallet (for verification)
 */

const API_URL = 'http://localhost:3000';

interface ApiResponse {
  success: boolean;
  [key: string]: unknown;
}

interface HealthResponse {
  status: string;
  timestamp: string;
  orderCount: number;
  matchingEngineRunning: boolean;
}

interface Market {
  marketId: string;
  conditionId: string;
  question: string;
  creator: string;
  yesPositionId: string;
  noPositionId: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  createdAt: number;
  resolved: boolean;
}

interface MarketResponse extends ApiResponse {
  market: Market;
}

interface OrderbookLevel {
  price: number;
  size: number;
  orderCount: number;
}

interface OrderbookResponse extends ApiResponse {
  orderbook: {
    positionId: string;
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
  };
}

interface Trade {
  tradeId: string;
  marketId: string;
  price: number;
  size: number;
  timestamp: number;
}

interface TradesResponse extends ApiResponse {
  trades: Trade[];
  count: number;
}

interface PriceResponse extends ApiResponse {
  prices: {
    yesMid: number;
    noMid: number;
    lastTrade?: number;
    bestBid?: number;
    bestAsk?: number;
  };
}

async function testAPI() {
  console.log('🧪 Testing Stackcast API\n');

  try {
    // 1. Health check
    console.log('1️⃣  Health Check...');
    const health = await fetch(`${API_URL}/health`).then(r => r.json() as Promise<HealthResponse>);
    console.log('   ✅ Server is running:', health);
    console.log();

    // 2. Create a market
    console.log('2️⃣  Creating market...');
    const marketRes = await fetch(`${API_URL}/api/markets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Will BTC hit $100k by Dec 31, 2025?',
        creator: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM'
      })
    }).then(r => r.json() as Promise<MarketResponse>);

    console.log('   ✅ Market created:', marketRes.market.marketId);
    console.log('      Question:', marketRes.market.question);
    const marketId = marketRes.market.marketId;
    const yesPositionId = marketRes.market.yesPositionId;
    console.log();

    // 3. Market maker places sell orders
    // NOTE: Signatures are optional for testing. In production, include:
    // - signature: wallet signature of order hash
    // - publicKey: wallet's public key for verification
    console.log('3️⃣  Market maker placing SELL orders...');
    await fetch(`${API_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maker: 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG',
        marketId,
        positionId: yesPositionId,
        side: 'SELL',
        price: 66,
        size: 5000,
        salt: `${Date.now()}_1`,
        expiration: 999999999
        // signature: '<wallet_signature>' (optional for testing)
        // publicKey: '<wallet_public_key>' (required if signature provided)
      })
    });
    console.log('   ✅ Sell order placed: 5000 @ 66');

    await fetch(`${API_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maker: 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG',
        marketId,
        positionId: yesPositionId,
        side: 'SELL',
        price: 68,
        size: 3000,
        salt: `${Date.now()}_2`,
        expiration: 999999999
      })
    });
    console.log('   ✅ Sell order placed: 3000 @ 68');
    console.log();

    // 4. Market maker places buy orders
    console.log('4️⃣  Market maker placing BUY orders...');
    await fetch(`${API_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maker: 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG',
        marketId,
        positionId: yesPositionId,
        side: 'BUY',
        price: 64,
        size: 5000,
        salt: `${Date.now()}_3`,
        expiration: 999999999
      })
    });
    console.log('   ✅ Buy order placed: 5000 @ 64');
    console.log();

    // 5. Check orderbook
    console.log('5️⃣  Checking orderbook...');
    await new Promise(resolve => setTimeout(resolve, 200));
    const orderbookRes = await fetch(`${API_URL}/api/orderbook/${marketId}?positionId=${yesPositionId}`)
      .then(r => r.json() as Promise<OrderbookResponse>);
    console.log('   📊 Orderbook:');
    console.log('      Bids:', orderbookRes.orderbook.bids);
    console.log('      Asks:', orderbookRes.orderbook.asks);
    console.log();

    // 6. Trader buys (should match with sell order)
    console.log('6️⃣  Trader placing BUY order (should match)...');
    await fetch(`${API_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maker: 'ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC',
        marketId,
        positionId: yesPositionId,
        side: 'BUY',
        price: 66,
        size: 1000,
        salt: `${Date.now()}_4`,
        expiration: 999999999
      })
    });
    console.log('   ✅ Buy order placed: 1000 @ 66');
    console.log();

    // 7. Wait for matching
    console.log('7️⃣  Waiting for matching engine...');
    await new Promise(resolve => setTimeout(resolve, 200));

    // 8. Check trades
    const tradesRes = await fetch(`${API_URL}/api/orderbook/${marketId}/trades`)
      .then(r => r.json() as Promise<TradesResponse>);
    console.log('   ✅ Trades executed:', tradesRes.count);
    if (tradesRes.count > 0) {
      console.log('      Latest trade:', tradesRes.trades[0]);
    }
    console.log();

    // 9. Check updated orderbook
    const updatedOrderbookRes = await fetch(`${API_URL}/api/orderbook/${marketId}?positionId=${yesPositionId}`)
      .then(r => r.json() as Promise<OrderbookResponse>);
    console.log('8️⃣  Updated orderbook:');
    console.log('      Bids:', updatedOrderbookRes.orderbook.bids);
    console.log('      Asks:', updatedOrderbookRes.orderbook.asks);
    console.log();

    // 10. Get market price
    const priceRes = await fetch(`${API_URL}/api/orderbook/${marketId}/price`)
      .then(r => r.json() as Promise<PriceResponse>);
    console.log('9️⃣  Market prices:');
    console.log('      YES mid-price:', priceRes.prices.yesMid);
    console.log('      NO mid-price:', priceRes.prices.noMid);
    console.log('      Last trade:', priceRes.prices.lastTrade);
    console.log();

    console.log('✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testAPI();
