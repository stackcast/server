import express, { type Request, type Response } from "express";
import { ExecutionPlan, SmartRouter } from "../services/smartRouter";
import { OrderSide, OrderType } from "../types/order";
import { verifyOrderSignatureMiddleware } from "../utils/signatureVerification";

export const smartOrderRoutes = express.Router();

/**
 * POST /api/smart-orders/preview - Preview order execution (no placement)
 *
 * Shows user exactly how their order would execute before they commit:
 * - Which price levels will be hit
 * - Average execution price
 * - Slippage percentage
 * - Whether there's enough liquidity
 *
 * Used by frontend to show real-time execution preview as user types
 *
 * Example request:
 * {
 *   "marketId": "market1",
 *   "outcome": "yes",
 *   "side": "BUY",
 *   "orderType": "MARKET",
 *   "size": 500,
 *   "maxSlippage": 5
 * }
 *
 * Example response:
 * {
 *   "success": true,
 *   "plan": {
 *     "feasible": true,
 *     "levels": [
 *       { "price": 65, "size": 200, "cost": 13000 },
 *       { "price": 66, "size": 300, "cost": 19800 }
 *     ],
 *     "averagePrice": 65.6,
 *     "slippage": 0.92,
 *     "totalCost": 32800
 *   }
 * }
 */
smartOrderRoutes.post("/preview", async (req: Request, res: Response) => {
  try {
    const orderManager = req.orderManager;
    const smartRouter = new SmartRouter(orderManager);

    const { marketId, outcome, side, orderType, size, price, maxSlippage } =
      req.body;

    // Validate required fields
    if (!marketId || !outcome || !side || !orderType || !size) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required fields: marketId, outcome, side, orderType, size",
      });
    }

    // Validate outcome
    if (outcome !== "yes" && outcome !== "no") {
      return res.status(400).json({
        success: false,
        error: "Invalid outcome. Must be 'yes' or 'no'",
      });
    }

    // Validate side
    if (side !== OrderSide.BUY && side !== OrderSide.SELL) {
      return res.status(400).json({
        success: false,
        error: "Invalid side. Must be BUY or SELL",
      });
    }

    // Validate order type
    if (orderType !== OrderType.LIMIT && orderType !== OrderType.MARKET) {
      return res.status(400).json({
        success: false,
        error: "Invalid orderType. Must be LIMIT or MARKET",
      });
    }

    // Validate size
    const numericSize = parseFloat(size);
    if (isNaN(numericSize) || numericSize <= 0) {
      return res.status(400).json({
        success: false,
        error: "Size must be greater than 0",
      });
    }

    // For LIMIT orders, price is required
    let numericPrice: number | undefined;
    if (orderType === OrderType.LIMIT) {
      if (price === undefined || price === null) {
        return res.status(400).json({
          success: false,
          error: "Price is required for LIMIT orders",
        });
      }
      numericPrice = parseFloat(price);
      if (isNaN(numericPrice) || numericPrice < 0 || numericPrice > 100) {
        return res.status(400).json({
          success: false,
          error: "Price must be between 0 and 100 cents",
        });
      }
    }

    // Generate execution plan
    const plan: ExecutionPlan = await smartRouter.planExecution({
      marketId,
      outcome,
      side,
      orderType,
      size: numericSize,
      limitPrice: numericPrice,
      maxSlippage: maxSlippage || 5, // Default 5% max slippage for market orders
    });

    return res.json({
      success: true,
      plan,
    });
  } catch (error) {
    console.error("Smart order preview error:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/smart-orders - Place order (LIMIT or MARKET)
 *
 * Unified endpoint for all order types with smart routing
 *
 * LIMIT orders:
 * - Rests in orderbook at specified price
 * - May not fill immediately
 * - User has full price control
 * Example: BUY 100 YES @ 66¢ → waits for seller at 66¢ or better
 *
 * MARKET orders:
 * - Fills immediately across multiple price levels
 * - Smart router splits into multiple limit orders
 * - Respects maxSlippage to prevent bad execution
 * Example: BUY 500 YES with 5% max slippage
 *   → Creates orders at [65¢×200, 66¢×300] if avg price acceptable
 *
 * Security:
 * - Validates signature (only wallet owner can place orders)
 * - Checks position IDs match market outcome
 * - Verifies execution plan feasibility
 *
 * Example request (MARKET):
 * {
 *   "maker": "SP2ABC...",
 *   "marketId": "market1",
 *   "outcome": "yes",
 *   "side": "BUY",
 *   "orderType": "MARKET",
 *   "size": 500,
 *   "maxSlippage": 5,
 *   "signature": "0x...",
 *   "publicKey": "02..."
 * }
 *
 * Example response (MARKET):
 * {
 *   "success": true,
 *   "orderType": "MARKET",
 *   "orders": [
 *     { "orderId": "order_123", "price": 65, "size": 200 },
 *     { "orderId": "order_124", "price": 66, "size": 300 }
 *   ],
 *   "executionPlan": {
 *     "averagePrice": 65.6,
 *     "totalCost": 32800,
 *     "slippage": 0.92
 *   }
 * }
 */
smartOrderRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const orderManager = req.orderManager;
    const smartRouter = new SmartRouter(orderManager);

    const {
      maker,
      marketId,
      side,
      outcome,
      orderType,
      price,
      size,
      maxSlippage,
      salt,
      expiration,
      signature,
      publicKey,
    } = req.body;

    // Validate required fields
    if (!maker || !marketId || !side || !outcome || !orderType || !size) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required fields: maker, marketId, side, outcome, orderType, size",
      });
    }

    // Validate side
    if (side !== OrderSide.BUY && side !== OrderSide.SELL) {
      return res.status(400).json({
        success: false,
        error: "Invalid side. Must be BUY or SELL",
      });
    }

    // Validate outcome
    if (outcome !== "yes" && outcome !== "no") {
      return res.status(400).json({
        success: false,
        error: "Invalid outcome. Must be 'yes' or 'no'",
      });
    }

    // Validate order type
    if (orderType !== OrderType.LIMIT && orderType !== OrderType.MARKET) {
      return res.status(400).json({
        success: false,
        error: "Invalid orderType. Must be LIMIT or MARKET",
      });
    }

    // Validate size
    const numericSize = parseFloat(size);
    if (isNaN(numericSize) || numericSize <= 0) {
      return res.status(400).json({
        success: false,
        error: "Size must be greater than 0",
      });
    }

    // Get market data
    const market = await orderManager.getMarket(marketId);
    if (!market) {
      return res.status(404).json({
        success: false,
        error: "Market not found",
      });
    }

    // Determine position IDs based on side and outcome
    let makerPositionId: string;
    let takerPositionId: string;

    if (side === OrderSide.BUY) {
      makerPositionId =
        outcome === "yes" ? market.yesPositionId : market.noPositionId;
      takerPositionId =
        outcome === "yes" ? market.noPositionId : market.yesPositionId;
    } else {
      makerPositionId =
        outcome === "yes" ? market.noPositionId : market.yesPositionId;
      takerPositionId =
        outcome === "yes" ? market.yesPositionId : market.noPositionId;
    }

    // MARKET ORDER: Multi-level execution
    if (orderType === OrderType.MARKET) {
      // Get execution plan
      const plan = await smartRouter.planExecution({
        marketId,
        outcome,
        side,
        orderType: OrderType.MARKET,
        size: numericSize,
        maxSlippage: maxSlippage || 5,
      });

      if (!plan.feasible) {
        return res.status(400).json({
          success: false,
          error: `Cannot execute market order: ${plan.reason}`,
          plan,
        });
      }

      // Require signature for market orders
      if (!signature || !publicKey) {
        return res.status(400).json({
          success: false,
          error: "Signature and publicKey required for market orders",
          plan, // Return plan so frontend can show preview and get signature
        });
      }

      // Place orders at each execution level
      const orders = [];
      for (const level of plan.levels) {
        const levelSalt = salt || `${Date.now()}_${Math.random()}`;
        const levelExpiration = expiration || 999999999;

        // Verify signature for each sub-order
        const makerAmount = level.size;
        const takerAmount = level.size * level.price;

        const verificationResult = await verifyOrderSignatureMiddleware({
          maker,
          taker: maker,
          makerPositionId,
          takerPositionId,
          makerAmount,
          takerAmount,
          salt: levelSalt,
          expiration: levelExpiration,
          signature,
          publicKey,
        });

        if (!verificationResult.valid) {
          return res.status(400).json({
            success: false,
            error: `Signature verification failed for level @ ${level.price}: ${verificationResult.error}`,
          });
        }

        // Add order to orderbook
        const order = await orderManager.addOrder({
          maker,
          marketId: market.marketId,
          conditionId: market.conditionId,
          makerPositionId,
          takerPositionId,
          side,
          price: level.price,
          size: level.size,
          salt: levelSalt,
          expiration: levelExpiration,
          signature,
          publicKey,
        });

        orders.push({
          orderId: order.orderId,
          price: order.price,
          size: order.size,
        });
      }

      return res.json({
        success: true,
        orderType: OrderType.MARKET,
        orders,
        executionPlan: {
          averagePrice: plan.averagePrice,
          totalCost: plan.totalCost,
          slippage: plan.slippage,
          levels: plan.levels.length,
        },
        message: `Market order placed: ${
          orders.length
        } orders totaling ${numericSize} ${outcome.toUpperCase()} @ avg ${plan.averagePrice.toFixed(
          2
        )}¢`,
      });
    }

    // LIMIT ORDER: Single order at specified price
    const numericPrice = parseFloat(price);
    if (isNaN(numericPrice) || numericPrice < 0 || numericPrice > 100) {
      return res.status(400).json({
        success: false,
        error: "Price must be between 0 and 100 cents for LIMIT orders",
      });
    }

    // If signature is not provided, return requirements
    if (!signature || !publicKey) {
      return res.json({
        success: true,
        marketId,
        conditionId: market.conditionId,
        side,
        outcome,
        orderType: OrderType.LIMIT,
        price: numericPrice,
        size: numericSize,
        makerPositionId,
        takerPositionId,
        requiresSignature: true,
        message: "Please sign this order with your wallet",
      });
    }

    // Verify signature
    const makerAmount = numericSize;
    const takerAmount = numericSize * numericPrice;

    const verificationResult = await verifyOrderSignatureMiddleware({
      maker,
      taker: maker,
      makerPositionId,
      takerPositionId,
      makerAmount,
      takerAmount,
      salt: salt || "",
      expiration: expiration || 0,
      signature,
      publicKey,
    });

    if (!verificationResult.valid) {
      return res.status(400).json({
        success: false,
        error: `Signature verification failed: ${verificationResult.error}`,
      });
    }

    // Add order to the book
    const order = await orderManager.addOrder({
      maker,
      marketId: market.marketId,
      conditionId: market.conditionId,
      makerPositionId,
      takerPositionId,
      side,
      price: numericPrice,
      size: numericSize,
      salt: salt || "",
      expiration: expiration || 0,
      signature,
      publicKey,
    });

    return res.json({
      success: true,
      orderType: OrderType.LIMIT,
      order: {
        orderId: order.orderId,
        marketId: order.marketId,
        side: order.side,
        outcome,
        price: order.price,
        size: order.size,
        status: order.status,
      },
      message: `Limit order placed: ${side} ${numericSize} ${outcome.toUpperCase()} @ ${numericPrice}¢`,
    });
  } catch (error) {
    console.error("Smart order placement error:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Get order requirements - tells frontend what user needs to do
 * before placing an order (e.g., split-position)
 * (Kept from original implementation)
 */
smartOrderRoutes.post("/requirements", async (req: Request, res: Response) => {
  try {
    const orderManager = req.orderManager;

    const { maker, marketId, side, outcome, size } = req.body;

    if (!maker || !marketId || !side || !outcome || !size) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    const market = await orderManager.getMarket(marketId);
    if (!market) {
      return res.status(404).json({
        success: false,
        error: "Market not found",
      });
    }

    // Determine which position ID the maker needs
    let requiredPositionId: string;

    if (side === OrderSide.BUY) {
      requiredPositionId =
        outcome === "yes" ? market.noPositionId : market.yesPositionId;
    } else {
      requiredPositionId =
        outcome === "yes" ? market.yesPositionId : market.noPositionId;
    }

    return res.json({
      success: true,
      requirements: {
        marketId,
        conditionId: market.conditionId,
        requiredPositionId,
        requiredAmount: parseFloat(size),
        action:
          side === OrderSide.BUY
            ? `Buying ${outcome.toUpperCase()}`
            : `Selling ${outcome.toUpperCase()}`,
        hint:
          side === OrderSide.BUY
            ? `To buy ${outcome.toUpperCase()}, you can either: 1) Split collateral to get both YES+NO tokens, 2) Buy from someone selling ${outcome.toUpperCase()}`
            : `To sell ${outcome.toUpperCase()}, you must own ${outcome.toUpperCase()} tokens. Call split-position if you don't have them.`,
      },
    });
  } catch (error) {
    console.error("Requirements check error:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
