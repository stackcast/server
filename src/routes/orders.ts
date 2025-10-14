import { Router, Request, Response } from "express";
import { Order, OrderSide } from "../types/order";
import { verifyOrderSignatureMiddleware } from "../utils/signatureVerification";

export const orderRoutes = Router();

// Create new order
orderRoutes.post("/", async (req: Request, res: Response) => {
  const {
    maker,
    marketId,
    conditionId,
    makerPositionId,
    takerPositionId,
    side,
    price,
    size,
    salt,
    expiration,
    signature,
    publicKey,
  } = req.body;

  // Validation
  if (
    !maker ||
    !marketId ||
    !side ||
    price === undefined ||
    size === undefined
  ) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields",
    });
  }

  // Get market to derive position IDs if not provided
  const market = await req.orderManager.getMarket(marketId);
  if (!market) {
    return res.status(404).json({
      success: false,
      error: "Market not found",
    });
  }

  // Derive position IDs based on side if not explicitly provided
  const finalMakerPositionId = makerPositionId ||
    (side === OrderSide.BUY ? market.yesPositionId : market.noPositionId);
  const finalTakerPositionId = takerPositionId ||
    (side === OrderSide.BUY ? market.noPositionId : market.yesPositionId);

  if (side !== OrderSide.BUY && side !== OrderSide.SELL) {
    return res.status(400).json({
      success: false,
      error: "Invalid side. Must be BUY or SELL",
    });
  }

  if (price <= 0 || price >= 100) {
    return res.status(400).json({
      success: false,
      error: "Price must be between 0 and 100",
    });
  }

  if (size <= 0) {
    return res.status(400).json({
      success: false,
      error: "Size must be positive",
    });
  }

  // Verify signature if provided (optional for now, will be required in production)
  if (signature) {
    if (!publicKey) {
      return res.status(400).json({
        success: false,
        error: "publicKey is required when signature is provided",
      });
    }

    const signatureVerification = await verifyOrderSignatureMiddleware({
      maker,
      taker: maker, // For limit orders, taker is same as maker
      makerPositionId: finalMakerPositionId,
      takerPositionId: finalTakerPositionId,
      makerAmount: size,
      takerAmount: Math.floor(size * price), // Calculate taker amount from price
      salt: salt || `${Date.now()}`,
      expiration: expiration || 999999999,
      signature,
      publicKey,
    });

    if (!signatureVerification.valid) {
      return res.status(401).json({
        success: false,
        error: signatureVerification.error || "Invalid signature",
      });
    }
  }

  try {
    const order = await req.orderManager.addOrder({
      maker,
      marketId,
      conditionId: conditionId || market.conditionId,
      makerPositionId: finalMakerPositionId,
      takerPositionId: finalTakerPositionId,
      side,
      price,
      size,
      salt: salt || `${Date.now()}`,
      expiration: expiration || 999999999, // Very high block number
      signature,
    });

    res.json({
      success: true,
      order,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get order by ID
orderRoutes.get("/:orderId", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const order = await req.orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).json({
      success: false,
      error: "Order not found",
    });
  }

  res.json({
    success: true,
    order,
  });
});

// Get user's orders
orderRoutes.get("/user/:address", async (req: Request, res: Response) => {
  const { address } = req.params;
  const { status, marketId } = req.query;

  let orders = await req.orderManager.getUserOrders(address);

  // Filter by status
  if (status) {
    orders = orders.filter((o: Order) => o.status === status);
  }

  // Filter by market
  if (marketId) {
    orders = orders.filter((o: Order) => o.marketId === marketId);
  }

  res.json({
    success: true,
    orders,
    count: orders.length,
  });
});

// Cancel order
orderRoutes.delete("/:orderId", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { maker } = req.body; // In production, verify signature

  const order = await req.orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).json({
      success: false,
      error: "Order not found",
    });
  }

  // Verify maker (in production, verify signature)
  if (maker && order.maker !== maker) {
    return res.status(403).json({
      success: false,
      error: "Not authorized to cancel this order",
    });
  }

  const cancelled = await req.orderManager.cancelOrder(orderId);

  if (!cancelled) {
    return res.status(400).json({
      success: false,
      error: "Cannot cancel this order (already filled or cancelled)",
    });
  }

  res.json({
    success: true,
    message: "Order cancelled",
  });
});
