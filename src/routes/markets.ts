import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';

export const marketRoutes = Router();

// Get all markets
marketRoutes.get('/', (req: Request, res: Response) => {
  const orderManager = (req as any).orderManager;
  const markets = orderManager.getAllMarkets();

  res.json({
    success: true,
    markets,
    count: markets.length
  });
});

// Get specific market
marketRoutes.get('/:marketId', (req: Request, res: Response) => {
  const orderManager = (req as any).orderManager;
  const { marketId } = req.params;

  const market = orderManager.getMarket(marketId);

  if (!market) {
    return res.status(404).json({
      success: false,
      error: 'Market not found'
    });
  }

  res.json({
    success: true,
    market
  });
});

// Create new market (would typically be called by admin/oracle adapter)
marketRoutes.post('/', (req: Request, res: Response) => {
  const orderManager = (req as any).orderManager;
  const { question, creator, conditionId } = req.body;

  if (!question || !creator) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: question, creator'
    });
  }

  const marketId = conditionId || `market_${Date.now()}_${randomBytes(8).toString('hex')}`;
  const yesPositionId = `${marketId}_yes`;
  const noPositionId = `${marketId}_no`;

  const market = {
    marketId,
    conditionId: conditionId || marketId,
    question,
    creator,
    yesPositionId,
    noPositionId,
    yesPrice: 50, // Default to 50/50
    noPrice: 50,
    volume24h: 0,
    createdAt: Date.now(),
    resolved: false
  };

  orderManager.addMarket(market);

  res.json({
    success: true,
    market
  });
});

// Get market stats
marketRoutes.get('/:marketId/stats', (req: Request, res: Response) => {
  const orderManager = (req as any).orderManager;
  const matchingEngine = (req as any).matchingEngine;
  const { marketId } = req.params;

  const market = orderManager.getMarket(marketId);

  if (!market) {
    return res.status(404).json({
      success: false,
      error: 'Market not found'
    });
  }

  const orders = orderManager.getMarketOrders(marketId);
  const trades = matchingEngine.getTrades(marketId);

  res.json({
    success: true,
    stats: {
      totalOrders: orders.length,
      openOrders: orders.filter(o => o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED').length,
      totalTrades: trades.length,
      volume24h: market.volume24h,
      lastPrice: trades[0]?.price || market.yesPrice
    }
  });
});
