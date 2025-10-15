import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { marketRoutes } from './routes/markets';
import { orderRoutes } from './routes/orders';
import { orderbookRoutes } from './routes/orderbook';
import { oracleRoutes } from './routes/oracle';
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

// Initialize services
const networkType = (process.env.STACKS_NETWORK as 'mainnet' | 'testnet' | 'devnet') || 'testnet';

const orderManager = new OrderManagerRedis();
const settlementService = new StacksSettlementService({
  network: networkType,
  contractIdentifier: process.env.CTF_EXCHANGE_ADDRESS,
  operatorPrivateKey: process.env.STACKS_OPERATOR_PRIVATE_KEY,
  apiUrl: process.env.STACKS_API_URL,
});
const matchingEngine = new MatchingEngine(orderManager, settlementService);
const stacksMonitor = new StacksMonitor(orderManager, networkType);

// Start services
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
app.use('/api/orders', orderRoutes);
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
