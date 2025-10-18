import { Request, Response, Router } from "express";
import { deriveYesNoPrices, PRICE_SCALE } from "../utils/pricing";

export const orderbookRoutes = Router();

// Get orderbook for a market
orderbookRoutes.get("/:marketId", async (req: Request, res: Response) => {
  const { marketId } = req.params;
  const { positionId } = req.query;

  const market = await req.orderManager.getMarket(marketId);

  if (!market) {
    return res.status(404).json({
      success: false,
      error: "Market not found",
    });
  }

  // If no positionId specified, return both YES and NO orderbooks
  if (!positionId) {
    const [yesBook, noBook] = await Promise.all([
      req.orderManager.getOrderbook(marketId, market.yesPositionId),
      req.orderManager.getOrderbook(marketId, market.noPositionId),
    ]);

    return res.json({
      success: true,
      market: {
        marketId: market.marketId,
        question: market.question,
      },
      orderbooks: {
        yes: {
          positionId: market.yesPositionId,
          bids: yesBook.bids,
          asks: yesBook.asks,
        },
        no: {
          positionId: market.noPositionId,
          bids: noBook.bids,
          asks: noBook.asks,
        },
      },
      timestamp: Date.now(),
    });
  }

  // Return specific position orderbook
  const orderbook = await req.orderManager.getOrderbook(
    marketId,
    positionId as string
  );

  res.json({
    success: true,
    market: {
      marketId: market.marketId,
      question: market.question,
    },
    orderbook: {
      positionId,
      bids: orderbook.bids,
      asks: orderbook.asks,
    },
    timestamp: Date.now(),
  });
});

// Get recent trades
orderbookRoutes.get("/:marketId/trades", (req: Request, res: Response) => {
  const { marketId } = req.params;
  const limit = parseInt(req.query.limit as string) || 50;

  const trades = req.matchingEngine.getTrades(marketId, limit);

  res.json({
    success: true,
    trades,
    count: trades.length,
  });
});

// Get mid-price for a market
orderbookRoutes.get("/:marketId/price", async (req: Request, res: Response) => {
  const { marketId } = req.params;

  const market = await req.orderManager.getMarket(marketId);

  if (!market) {
    return res.status(404).json({
      success: false,
      error: "Market not found",
    });
  }

  // Get orderbook for YES position
  const orderbook = await req.orderManager.getOrderbook(
    marketId,
    market.yesPositionId
  );

  // Get last trade price
  const trades = req.matchingEngine.getTrades(marketId, 1);
  const latestTrade = trades[0];

  let lastTradePrice: number | undefined;
  if (latestTrade) {
    const involvesYesPosition =
      latestTrade.makerPositionId === market.yesPositionId ||
      latestTrade.takerPositionId === market.yesPositionId;
    lastTradePrice = involvesYesPosition
      ? latestTrade.price
      : Math.max(0, PRICE_SCALE - latestTrade.price);
  }

  const bestBid = orderbook.bids[0]?.price;
  const bestAsk = orderbook.asks[0]?.price;

  const { yesPrice, noPrice } = deriveYesNoPrices({
    bestBid,
    bestAsk,
    lastTradePrice,
    currentYesPrice: market.yesPrice,
  });

  await req.orderManager.updateMarketPrices(market.marketId, yesPrice, noPrice);

  res.json({
    success: true,
    marketId,
    prices: {
      yesMid: yesPrice,
      noMid: noPrice,
      lastTrade: lastTradePrice,
      bestBid,
      bestAsk,
    },
    timestamp: Date.now(),
  });
});
