import express, { type Request, type Response, type NextFunction } from "express";

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

export const adminRoutes = express.Router();

function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "Admin API key is not configured on this server",
    });
  }

  const headerKey =
    (req.headers["x-admin-key"] as string | undefined) ||
    (req.headers["x-api-key"] as string | undefined);

  if (!headerKey || headerKey !== ADMIN_API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Invalid or missing admin key",
    });
  }

  return next();
}

adminRoutes.use(requireAdminKey);

adminRoutes.post(
  "/settlements/:tradeId",
  async (req: Request, res: Response) => {
    try {
      const { tradeId } = req.params;
      const settlementService = req.settlementService;

      if (!settlementService || !settlementService.isEnabled()) {
        return res.status(503).json({
          success: false,
          error: "Settlement service is not enabled",
        });
      }

      const trade = req.matchingEngine.getTrade(tradeId);
      if (!trade) {
        return res.status(404).json({
          success: false,
          error: `Trade ${tradeId} not found`,
        });
      }

      const [makerOrder, takerOrder] = await Promise.all([
        req.orderManager.getOrder(trade.makerOrderId),
        req.orderManager.getOrder(trade.takerOrderId),
      ]);

      if (!makerOrder || !takerOrder) {
        return res.status(404).json({
          success: false,
          error: "Maker or taker order not found",
        });
      }

      const txId = await settlementService.submitFill({
        trade,
        makerOrder,
        takerOrder,
        fillAmount: trade.size,
        executionPrice: trade.price,
      });

      if (txId) {
        req.matchingEngine.recordTradeSettlement(trade.tradeId, txId);
      }

      return res.json({
        success: true,
        tradeId,
        txId,
      });
    } catch (error) {
      console.error("Admin settlement error:", error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);
