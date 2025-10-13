import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { Order, OrderStatus } from '../types/order';

export const marketRoutes = Router();

// Get all markets
marketRoutes.get('/', async (req: Request, res: Response) => {
  const markets = await req.orderManager.getAllMarkets();

  res.json({
    success: true,
    markets,
    count: markets.length
  });
});

// Get specific market
marketRoutes.get('/:marketId', async (req: Request, res: Response) => {
  const { marketId } = req.params;
  const market = await req.orderManager.getMarket(marketId);

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
marketRoutes.post('/', async (req: Request, res: Response) => {
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

  await req.orderManager.addMarket(market);

  res.json({
    success: true,
    market
  });
});

// Get market stats
marketRoutes.get('/:marketId/stats', async (req: Request, res: Response) => {
  const { marketId } = req.params;
  const market = await req.orderManager.getMarket(marketId);

  if (!market) {
    return res.status(404).json({
      success: false,
      error: 'Market not found'
    });
  }

  const orders: Order[] = await req.orderManager.getMarketOrders(marketId);
  const trades = req.matchingEngine.getTrades(marketId);

  res.json({
    success: true,
    stats: {
      totalOrders: orders.length,
      openOrders: orders.filter((o: Order) =>
        o.status === OrderStatus.OPEN || o.status === OrderStatus.PARTIALLY_FILLED
      ).length,
      totalTrades: trades.length,
      volume24h: market.volume24h,
      lastPrice: trades[0]?.price || market.yesPrice
    }
  });
});
