import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { marketRoutes } from './routes/markets';
import { orderRoutes } from './routes/orders';
import { orderbookRoutes } from './routes/orderbook';
import { MatchingEngine } from './services/matchingEngine';
import { OrderManager } from './services/orderManager';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize services
const orderManager = new OrderManager();
const matchingEngine = new MatchingEngine(orderManager);

// Start matching engine
matchingEngine.start();

// Attach services to request
app.use((req, res, next) => {
  (req as any).orderManager = orderManager;
  (req as any).matchingEngine = matchingEngine;
  next();
});

// Routes
app.use('/api/markets', marketRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/orderbook', orderbookRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    orderCount: orderManager.getOrderCount(),
    matchingEngineRunning: matchingEngine.isRunning()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Stackcast CLOB API running on port ${PORT}`);
  console.log(`📊 Matching engine started`);
});

export { orderManager, matchingEngine };
