import type { ClarityValue } from "@stacks/transactions";
import {
  cvToHex,
  cvToJSON,
  fetchCallReadOnlyFunction,
  hexToCV,
} from "@stacks/transactions";
import { Router } from "express";
import { stacksApiBaseUrl, stacksNetwork } from "../utils/stacksNetwork";

export const stacksRoutes = Router();

stacksRoutes.post("/read", async (req, res) => {
  try {
    const {
      contractAddress,
      contractName,
      functionName,
      functionArgs = [],
      senderAddress,
    } = req.body as {
      contractAddress?: string;
      contractName?: string;
      functionName?: string;
      functionArgs?: string[];
      senderAddress?: string;
    };

    if (!contractAddress || !contractName || !functionName) {
      return res.status(400).json({
        success: false,
        error:
          "contractAddress, contractName, and functionName are required fields",
      });
    }

    const clarityArgs: ClarityValue[] = functionArgs.map((arg) => {
      if (typeof arg !== "string") {
        throw new Error("functionArgs must be an array of hex strings");
      }
      return hexToCV(arg);
    });

    const result = await fetchCallReadOnlyFunction({
      contractAddress,
      contractName,
      functionName,
      functionArgs: clarityArgs,
      network: stacksNetwork,
      senderAddress: senderAddress ?? contractAddress,
    });

    const hexResult = cvToHex(result);

    return res.json({
      success: true,
      result: hexResult,
      value: cvToJSON(result),
    });
  } catch (error) {
    console.error("Stacks read proxy error:", error);
    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to execute read-only function",
    });
  }
});

stacksRoutes.get("/tx/:txId", async (req, res) => {
  const { txId } = req.params;

  if (!txId) {
    return res.status(400).json({
      success: false,
      error: "Transaction ID is required",
    });
  }

  try {
    const response = await fetch(`${stacksApiBaseUrl}/extended/v1/tx/${txId}`);

    if (response.status === 404) {
      return res.json({
        success: true,
        tx_status: "not_found",
      });
    }

    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({
        success: false,
        error: body || `Failed to fetch transaction ${txId}`,
      });
    }

    const data = (await response.json()) as Record<string, unknown>;
    return res.json({ success: true, ...data });
  } catch (error) {
    console.error("Stacks tx proxy error:", error);
    return res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to fetch transaction",
    });
  }
});
