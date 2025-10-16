/**
 * StackCast CLOB Server - Off-chain matching, on-chain settlement
 *
 * Architecture:
 * ┌──────────────┐
 * │   Frontend   │ User signs orders with Stacks wallet
 * └──────┬───────┘
 *        │ HTTP (signed orders)
 * ┌──────▼───────────────────────────────────────────────────┐
 * │              Express API Server                           │
 * │  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │
 * │  │   Routes   │→ │OrderManager  │→ │  Redis (Upstash)│  │
 * │  │(smartOrders│  │  (storage)   │  │  - Orders       │  │
 * │  │ orderbook) │  └──────────────┘  │  - Orderbook    │  │
 * │  └────────────┘                    │  - Markets      │  │
 * └──────────────────────────────────────┬─────────────────┘
 *                                        │
 *        ┌───────────────────────────────┴─────────────┐
 *        │                                             │
 * ┌──────▼──────────┐                        ┌────────▼──────┐
 * │MatchingEngine   │ Every 100ms            │StacksMonitor  │ Every 30s
 * │- Pairs buy/sell │                        │- Block height │
 * │- Price-time     │                        │- Expire orders│
 * │  priority       │                        └───────────────┘
 * └──────┬──────────┘
 *        │ Matched trades
 * ┌──────▼──────────────┐
 * │SettlementService    │
 * │- Broadcast Stacks tx│
 * │- Update with txHash │
 * └──────┬──────────────┘
 *        │
 * ┌──────▼────────────────────────────┐
 * │  Stacks Blockchain                │
 * │  - ctf-exchange.clar              │
 * │  - Verify signatures              │
 * │  - Atomic token swaps (YES↔NO)    │
 * │  - 0.5% protocol fee              │
 * └───────────────────────────────────┘
 *
 * Data flow example: User places "BUY 100 YES @ 66¢"
 * 1. Frontend: Signs order hash → POST /api/smart-orders
 * 2. Server: Verifies signature, stores in Redis orderbook
 * 3. MatchingEngine: Finds matching SELL order @ 65¢
 * 4. MatchingEngine: Creates trade, updates filled amounts
 * 5. SettlementService: Broadcasts tx to ctf-exchange.clar
 * 6. Blockchain: Verifies sigs, swaps 100 YES ↔ 6500¢ of NO
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { marketRoutes } from './routes/markets';
import { orderbookRoutes } from './routes/orderbook';
import { oracleRoutes } from './routes/oracle';
import { smartOrderRoutes } from './routes/smartOrders';
import { MatchingEngine } from './services/matchingEngine';
import { OrderManagerRedis } from './services/orderManagerRedis';
import { StacksMonitor } from './services/stacksMonitor';
import { StacksSettlementService } from './services/stacksSettlement';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize core services
const networkType = (process.env.STACKS_NETWORK as 'mainnet' | 'testnet' | 'devnet') || 'testnet';

// 1. Order storage and indexing (Redis)
const orderManager = new OrderManagerRedis();

// 2. On-chain settlement (optional, skips if env vars missing)
const settlementService = new StacksSettlementService({
  network: networkType,
  contractIdentifier: process.env.CTF_EXCHANGE_ADDRESS,
  operatorPrivateKey: process.env.STACKS_OPERATOR_PRIVATE_KEY,
  apiUrl: process.env.STACKS_API_URL,
});

// 3. Continuous order matching (100ms loop)
const matchingEngine = new MatchingEngine(orderManager, settlementService);

// 4. Blockchain monitoring for order expiration (30s loop)
const stacksMonitor = new StacksMonitor(orderManager, networkType);

// Start background services
matchingEngine.start();
stacksMonitor.start();

// Attach services to request
app.use((req, _res, next) => {
  req.orderManager = orderManager;
  req.matchingEngine = matchingEngine;
  next();
});

// Routes
app.use('/api/markets', marketRoutes);
app.use('/api/smart-orders', smartOrderRoutes);
app.use('/api/orderbook', orderbookRoutes);
app.use('/api/oracle', oracleRoutes);

// Health check
app.get('/health', async (_req, res) => {
  const orderCount = await orderManager.getOrderCount();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    orderCount,
    matchingEngineRunning: matchingEngine.isRunning(),
    stacksMonitorRunning: stacksMonitor.isRunning(),
    currentBlockHeight: stacksMonitor.getCurrentBlockHeight()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Stackcast CLOB API running on port ${PORT}`);
  console.log(`📊 Matching engine started`);
  console.log(`⛓️  Stacks monitor started`);
});

export { orderManager, matchingEngine, stacksMonitor, settlementService };
