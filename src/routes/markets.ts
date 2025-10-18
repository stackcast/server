import { serializeCV, uintCV } from "@stacks/transactions";
import { createHash, randomBytes } from "crypto";
import { Request, Response, Router } from "express";
import { Order, OrderStatus } from "../types/order";
import { PRICE_SCALE } from "../utils/pricing";

/**
 * Generate position ID matching the Clarity contract's get-position-id function
 * Contract: (sha256 (concat condition-id (to-consensus-buff? outcome-index)))
 */
function getPositionId(conditionId: string, outcomeIndex: number): string {
  const conditionIdHex = conditionId.startsWith("0x")
    ? conditionId.slice(2)
    : conditionId;
  const conditionIdBuff = Buffer.from(conditionIdHex, "hex");

  if (conditionIdBuff.length !== 32) {
    throw new Error(
      `Condition ID must be 32 bytes (64 hex chars), got ${conditionIdBuff.length} bytes`
    );
  }

  // Serialize outcome index using Stacks consensus format (matches to-consensus-buff?)
  const outcomeIndexBuff = Buffer.from(serializeCV(uintCV(outcomeIndex)));

  // Concatenate and hash
  const concatenated = Buffer.concat([conditionIdBuff, outcomeIndexBuff]);
  const positionId = createHash("sha256").update(concatenated).digest("hex");

  return positionId;
}

export const marketRoutes = Router();

// Get all markets
marketRoutes.get("/", async (req: Request, res: Response) => {
  const markets = await req.orderManager.getAllMarkets();

  res.json({
    success: true,
    markets,
    count: markets.length,
  });
});

// Get specific market
marketRoutes.get("/:marketId", async (req: Request, res: Response) => {
  const { marketId } = req.params;
  const market = await req.orderManager.getMarket(marketId);

  if (!market) {
    return res.status(404).json({
      success: false,
      error: "Market not found",
    });
  }

  res.json({
    success: true,
    market,
  });
});

// Create new market (admin only - called by init script)
marketRoutes.post("/", async (req: Request, res: Response) => {
  // Check admin API key
  const apiKey = req.headers["x-api-key"] || req.headers["authorization"];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: "Forbidden: Admin API key required",
    });
  }

  const { question, creator, conditionId } = req.body;

  if (!question || !creator) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: question, creator",
    });
  }

  // Require explicit condition ID (from blockchain event or oracle adapter)
  // Markets should be created via oracle-adapter contract which generates the condition ID
  if (!conditionId) {
    return res.status(400).json({
      success: false,
      error:
        "Missing required field: conditionId. Markets must be initialized through oracle-adapter contract first.",
    });
  }

  // Normalize condition ID (remove 0x prefix if present)
  const finalConditionId = conditionId.startsWith("0x")
    ? conditionId.slice(2)
    : conditionId;

  // Ensure condition ID is 32 bytes (64 hex chars)
  if (finalConditionId.length !== 64) {
    return res.status(400).json({
      success: false,
      error: `Condition ID must be 32 bytes (64 hex chars), got ${
        finalConditionId.length / 2
      } bytes`,
    });
  }

  // Generate market ID
  const marketId = `market_${Date.now()}_${randomBytes(8).toString("hex")}`;

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
    yesPrice: PRICE_SCALE / 2,
    noPrice: PRICE_SCALE / 2,
    volume24h: 0,
    createdAt: Date.now(),
    resolved: false,
  };

  await req.orderManager.addMarket(market);

  res.json({
    success: true,
    market,
  });
});

// Get market stats
marketRoutes.get("/:marketId/stats", async (req: Request, res: Response) => {
  const { marketId } = req.params;
  const market = await req.orderManager.getMarket(marketId);

  if (!market) {
    return res.status(404).json({
      success: false,
      error: "Market not found",
    });
  }

  const orders: Order[] = await req.orderManager.getMarketOrders(marketId);
  const trades = req.matchingEngine.getTrades(marketId);

  const latestTrade = trades[0];
  const lastPrice = latestTrade
    ? latestTrade.makerPositionId === market.yesPositionId ||
      latestTrade.takerPositionId === market.yesPositionId
      ? latestTrade.price
      : Math.max(0, PRICE_SCALE - latestTrade.price)
    : market.yesPrice;

  res.json({
    success: true,
    stats: {
      totalOrders: orders.length,
      openOrders: orders.filter(
        (o: Order) =>
          o.status === OrderStatus.OPEN ||
          o.status === OrderStatus.PARTIALLY_FILLED
      ).length,
      totalTrades: trades.length,
      volume24h: market.volume24h,
      lastPrice,
    },
  });
});

// Get price history for chart (aggregated by time buckets)
marketRoutes.get(
  "/:marketId/price-history",
  async (req: Request, res: Response) => {
    const { marketId } = req.params;
    const { interval = "1h", limit = 100 } = req.query;

    const market = await req.orderManager.getMarket(marketId);
    if (!market) {
      return res.status(404).json({
        success: false,
        error: "Market not found",
      });
    }

    // Get all trades for this market
    const trades = req.matchingEngine.getTrades(marketId, 1000);

    if (trades.length === 0) {
      return res.json({
        success: true,
        priceHistory: [],
        currentPrice: { yes: market.yesPrice, no: market.noPrice },
      });
    }

    // Determine bucket size in milliseconds
    const intervalMs: Record<string, number> = {
      "5m": 5 * 60 * 1000,
      "15m": 15 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "4h": 4 * 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000,
    };

    const bucketSize = intervalMs[interval as string] || intervalMs["1h"];
    const maxDataPoints = Math.min(Number(limit), 200);

    // Group trades into time buckets
    const buckets: Map<
      number,
      { yes: number[]; no: number[]; timestamp: number }
    > = new Map();

    // Sort trades by timestamp (oldest first)
    const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);

    sortedTrades.forEach((trade) => {
      const bucketTime = Math.floor(trade.timestamp / bucketSize) * bucketSize;

      if (!buckets.has(bucketTime)) {
        buckets.set(bucketTime, { yes: [], no: [], timestamp: bucketTime });
      }

      const bucket = buckets.get(bucketTime)!;

      // Determine if this trade is for YES or NO outcome based on position IDs
      // If taker bought YES (takerPositionId = yesPositionId), it's a YES trade
      // If taker bought NO (takerPositionId = noPositionId), it's a NO trade
      const isYesOutcome = trade.takerPositionId === market.yesPositionId;

      if (isYesOutcome) {
        bucket.yes.push(trade.price);
      } else {
        bucket.no.push(trade.price);
      }
    });

    // Calculate OHLC (Open, High, Low, Close) for each bucket
    const priceHistory = Array.from(buckets.values())
      .slice(-maxDataPoints)
      .map((bucket) => {
        const yesPrices =
          bucket.yes.length > 0 ? bucket.yes : [market.yesPrice];
        const noPrices = bucket.no.length > 0 ? bucket.no : [market.noPrice];

        return {
          timestamp: bucket.timestamp,
          yes: {
            open: yesPrices[0],
            high: Math.max(...yesPrices),
            low: Math.min(...yesPrices),
            close: yesPrices[yesPrices.length - 1],
            volume: yesPrices.length,
          },
          no: {
            open: noPrices[0],
            high: Math.max(...noPrices),
            low: Math.min(...noPrices),
            close: noPrices[noPrices.length - 1],
            volume: noPrices.length,
          },
        };
      });

    res.json({
      success: true,
      priceHistory,
      currentPrice: {
        yes: market.yesPrice,
        no: market.noPrice,
      },
      interval,
      dataPoints: priceHistory.length,
    });
  }
);
