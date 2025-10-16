import { Request, Response, Router } from "express";

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
      req.orderManager.getOrderbook(
        marketId,
        market.yesPositionId,
        market.noPositionId
      ),
      req.orderManager.getOrderbook(
        marketId,
        market.noPositionId,
        market.yesPositionId
      ),
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
    positionId as string,
    market
      ? positionId === market.yesPositionId
        ? market.noPositionId
        : market.yesPositionId
      : undefined
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
    market.yesPositionId,
    market.noPositionId
  );

  // Calculate mid-price
  let yesPrice = 50; // Default
  if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
    const bestBid = orderbook.bids[0].price;
    const bestAsk = orderbook.asks[0].price;
    yesPrice = (bestBid + bestAsk) / 2;
  } else if (orderbook.bids.length > 0) {
    yesPrice = orderbook.bids[0].price;
  } else if (orderbook.asks.length > 0) {
    yesPrice = orderbook.asks[0].price;
  }

  // Get last trade price
  const trades = req.matchingEngine.getTrades(marketId, 1);
  const lastTradePrice = trades[0]?.price;

  res.json({
    success: true,
    marketId,
    prices: {
      yesMid: yesPrice,
      noMid: 100 - yesPrice,
      lastTrade: lastTradePrice,
      bestBid: orderbook.bids[0]?.price,
      bestAsk: orderbook.asks[0]?.price,
    },
    timestamp: Date.now(),
  });
});
