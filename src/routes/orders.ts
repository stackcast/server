import { Router, Request, Response } from 'express';
import { OrderSide } from '../types/order';

export const orderRoutes = Router();

// Create new order
orderRoutes.post('/', (req: Request, res: Response) => {
  const orderManager = (req as any).orderManager;
  const {
    maker,
    marketId,
    conditionId,
    positionId,
    side,
    price,
    size,
    salt,
    expiration,
    signature
  } = req.body;

  // Validation
  if (!maker || !marketId || !positionId || !side || price === undefined || size === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }

  if (side !== OrderSide.BUY && side !== OrderSide.SELL) {
    return res.status(400).json({
      success: false,
      error: 'Invalid side. Must be BUY or SELL'
    });
  }

  if (price <= 0 || price >= 100) {
    return res.status(400).json({
      success: false,
      error: 'Price must be between 0 and 100'
    });
  }

  if (size <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Size must be positive'
    });
  }

  // Check market exists
  const market = orderManager.getMarket(marketId);
  if (!market) {
    return res.status(404).json({
      success: false,
      error: 'Market not found'
    });
  }

  try {
    const order = orderManager.addOrder({
      maker,
      marketId,
      conditionId: conditionId || market.conditionId,
      positionId,
      side,
      price,
      size,
      salt: salt || `${Date.now()}`,
      expiration: expiration || 999999999, // Very high block number
      signature
    });

    res.json({
      success: true,
      order
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get order by ID
orderRoutes.get('/:orderId', (req: Request, res: Response) => {
  const orderManager = (req as any).orderManager;
  const { orderId } = req.params;

  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).json({
      success: false,
      error: 'Order not found'
    });
  }

  res.json({
    success: true,
    order
  });
});

// Get user's orders
orderRoutes.get('/user/:address', (req: Request, res: Response) => {
  const orderManager = (req as any).orderManager;
  const { address } = req.params;
  const { status, marketId } = req.query;

  let orders = orderManager.getUserOrders(address);

  // Filter by status
  if (status) {
    orders = orders.filter((o: any) => o.status === status);
  }

  // Filter by market
  if (marketId) {
    orders = orders.filter((o: any) => o.marketId === marketId);
  }

  res.json({
    success: true,
    orders,
    count: orders.length
  });
});

// Cancel order
orderRoutes.delete('/:orderId', (req: Request, res: Response) => {
  const orderManager = (req as any).orderManager;
  const { orderId } = req.params;
  const { maker } = req.body; // In production, verify signature

  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).json({
      success: false,
      error: 'Order not found'
    });
  }

  // Verify maker (in production, verify signature)
  if (maker && order.maker !== maker) {
    return res.status(403).json({
      success: false,
      error: 'Not authorized to cancel this order'
    });
  }

  const cancelled = orderManager.cancelOrder(orderId);

  if (!cancelled) {
    return res.status(400).json({
      success: false,
      error: 'Cannot cancel this order (already filled or cancelled)'
    });
  }

  res.json({
    success: true,
    message: 'Order cancelled'
  });
});
