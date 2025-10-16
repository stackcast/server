import { Router, Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { Order, OrderStatus } from '../types/order';
import { serializeCV, uintCV } from '@stacks/transactions';

/**
 * Generate position ID matching the Clarity contract's get-position-id function
 * Contract: (sha256 (concat condition-id (to-consensus-buff? outcome-index)))
 */
function getPositionId(conditionId: string, outcomeIndex: number): string {
  const conditionIdHex = conditionId.startsWith('0x') ? conditionId.slice(2) : conditionId;
  const conditionIdBuff = Buffer.from(conditionIdHex, 'hex');

  if (conditionIdBuff.length !== 32) {
    throw new Error(`Condition ID must be 32 bytes (64 hex chars), got ${conditionIdBuff.length} bytes`);
  }

  // Serialize outcome index using Stacks consensus format (matches to-consensus-buff?)
  const outcomeIndexBuff = Buffer.from(serializeCV(uintCV(outcomeIndex)));

  // Concatenate and hash
  const concatenated = Buffer.concat([conditionIdBuff, outcomeIndexBuff]);
  const positionId = createHash('sha256').update(concatenated).digest('hex');

  return positionId;
}

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

// Create new market (admin only - called by init script)
marketRoutes.post('/', async (req: Request, res: Response) => {
  // Check admin API key
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Admin API key required'
    });
  }

  const { question, creator, conditionId } = req.body;

  if (!question || !creator) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: question, creator'
    });
  }

  // Require explicit condition ID (from blockchain event or oracle adapter)
  // Markets should be created via oracle-adapter contract which generates the condition ID
  if (!conditionId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required field: conditionId. Markets must be initialized through oracle-adapter contract first.'
    });
  }

  // Normalize condition ID (remove 0x prefix if present)
  const finalConditionId = conditionId.startsWith('0x') ? conditionId.slice(2) : conditionId;

  // Ensure condition ID is 32 bytes (64 hex chars)
  if (finalConditionId.length !== 64) {
    return res.status(400).json({
      success: false,
      error: `Condition ID must be 32 bytes (64 hex chars), got ${finalConditionId.length / 2} bytes`
    });
  }

  // Generate market ID
  const marketId = `market_${Date.now()}_${randomBytes(8).toString('hex')}`;

  // Generate position IDs using the same algorithm as the contract
  const yesPositionId = getPositionId(finalConditionId, 0);
  const noPositionId = getPositionId(finalConditionId, 1);

  const market = {
    marketId,
    conditionId: finalConditionId,
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
