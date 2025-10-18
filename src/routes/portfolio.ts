import { Router } from "express";
import {
  bufferCV,
  cvToValue,
  fetchCallReadOnlyFunction,
  principalCV,
} from "@stacks/transactions";
import { hexToBytes } from "@stacks/common";
import { stacksNetwork } from "../utils/stacksNetwork";

type PortfolioPosition = {
  marketId: string;
  conditionId: string;
  question?: string;
  yesPositionId: string;
  noPositionId: string;
  yesBalance: string;
  noBalance: string;
  yesPrice: string;
  noPrice: string;
};

type PortfolioPayload = {
  positions: PortfolioPosition[];
  collateralBalance: string;
};

const portfolioCache = new Map<
  string,
  { timestamp: number; payload: PortfolioPayload }
>();
const CACHE_TTL_MS = 10_000;

const conditionalTokensIdentifier =
  process.env.CONDITIONAL_TOKENS_ADDRESS ?? "";
const exchangeIdentifier = process.env.CTF_EXCHANGE_ADDRESS ?? "";

if (!conditionalTokensIdentifier || !exchangeIdentifier) {
  console.warn(
    "Portfolio routes disabled: CONDITIONAL_TOKENS_ADDRESS or CTF_EXCHANGE_ADDRESS missing"
  );
}

export const portfolioRoutes = Router();

portfolioRoutes.get("/:address", async (req, res) => {
  try {
    if (!conditionalTokensIdentifier || !exchangeIdentifier) {
      return res.status(503).json({
        success: false,
        error: "Portfolio endpoint not configured",
      });
    }

    const { address } = req.params;

    if (!address || typeof address !== "string") {
      return res.status(400).json({
        success: false,
        error: "Invalid address",
      });
    }

    const cached = portfolioCache.get(address);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json({
        success: true,
        cached: true,
        ...cached.payload,
      });
    }

    const [ctAddress, ctName] = conditionalTokensIdentifier.split(".");
    const [exchangeAddress, exchangeName] = exchangeIdentifier.split(".");

    const userOrders = await req.orderManager.getUserOrders(address);
    const marketIds = new Set<string>();
    for (const order of userOrders) {
      marketIds.add(order.marketId);
    }

    // If no orders found, fall back to all markets but limit to a few to avoid rate limits
    const markets =
      marketIds.size > 0
        ? await Promise.all(
            Array.from(marketIds).map((id) => req.orderManager.getMarket(id))
          )
        : (await req.orderManager.getAllMarkets()).slice(0, 10);

    const positions: PortfolioPosition[] = [];

    for (const market of markets) {
      if (!market) continue;

      const yesBuffer = bufferCV(hexToBytes(market.yesPositionId.replace(/^0x/, "")));
      const noBuffer = bufferCV(hexToBytes(market.noPositionId.replace(/^0x/, "")));

      const yesResult = await fetchCallReadOnlyFunction({
        contractAddress: ctAddress,
        contractName: ctName,
        functionName: "balance-of",
        functionArgs: [principalCV(address), yesBuffer],
        network: stacksNetwork,
        senderAddress: address,
      });

      const noResult = await fetchCallReadOnlyFunction({
        contractAddress: ctAddress,
        contractName: ctName,
        functionName: "balance-of",
        functionArgs: [principalCV(address), noBuffer],
        network: stacksNetwork,
        senderAddress: address,
      });

      const yesValue = BigInt(cvToValue(yesResult) as bigint | number | string);
      const noValue = BigInt(cvToValue(noResult) as bigint | number | string);

      if (yesValue > 0n || noValue > 0n) {
        positions.push({
          marketId: market.marketId,
          conditionId: market.conditionId,
          question: market.question,
          yesPositionId: market.yesPositionId,
          noPositionId: market.noPositionId,
          yesPrice: market.yesPrice?.toString() ?? "0",
          noPrice: market.noPrice?.toString() ?? "0",
          yesBalance: yesValue.toString(),
          noBalance: noValue.toString(),
        });
      }
    }

    const collateralResult = await fetchCallReadOnlyFunction({
      contractAddress: exchangeAddress,
      contractName: exchangeName,
      functionName: "get-collateral-balance",
      functionArgs: [principalCV(address)],
      network: stacksNetwork,
      senderAddress: address,
    });

    const collateralValue = BigInt(
      cvToValue(collateralResult) as bigint | number | string
    );

    const payload = {
      positions,
      collateralBalance: collateralValue.toString(),
    };

    portfolioCache.set(address, { timestamp: Date.now(), payload });

    return res.json({
      success: true,
      cached: false,
      ...payload,
    });
  } catch (error) {
    console.error("Portfolio route error:", error);
    return res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to load portfolio",
    });
  }
});
