import { Router, Request, Response } from "express";
import {
  fetchCallReadOnlyFunction,
  cvToValue,
  bufferCV,
  principalCV,
} from "@stacks/transactions";
import {
  StacksNetwork,
  STACKS_MAINNET,
  STACKS_TESTNET,
  STACKS_DEVNET,
} from "@stacks/network";

export const oracleRoutes = Router();

// Get network instance
function getNetwork(networkType: string): StacksNetwork {
  switch (networkType) {
    case "mainnet":
      return STACKS_MAINNET;
    case "devnet":
      return STACKS_DEVNET;
    case "testnet":
    default:
      return STACKS_TESTNET;
  }
}

const NETWORK_TYPE =
  (process.env.STACKS_NETWORK as "mainnet" | "testnet" | "devnet") || "devnet";
const NETWORK = getNetwork(NETWORK_TYPE);

// Parse contract address from environment or use default
const ORACLE_ADDRESS =
  process.env.OPTIMISTIC_ORACLE_ADDRESS ||
  "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.optimistic-oracle";
const [contractAddress, contractName] = ORACLE_ADDRESS.split(".");

interface DisputeData {
  questionId: string;
  question: string;
  proposedAnswer: number;
  proposer: string;
  yesVotes: number;
  noVotes: number;
  votingEnds: number;
  resolved: boolean;
  finalAnswer?: number;
}

// Get all disputed questions (active voting)
oracleRoutes.get("/disputes", async (_req: Request, res: Response) => {
  try {
    // In a real implementation, we'd need to:
    // 1. Track question IDs (either indexing events or maintaining a registry)
    // 2. Query each question's state
    // For now, return mock data structure that the web app expects

    const disputes: DisputeData[] = [
      // This would be populated by reading from contract
      // For each known question-id, call get-question, get-proposal, get-dispute, get-vote-tally
    ];

    res.json({
      success: true,
      disputes,
      count: disputes.length,
    });
  } catch (error) {
    console.error("Error fetching disputes:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch disputes",
    });
  }
});

// Get specific question details
oracleRoutes.get(
  "/questions/:questionId",
  async (req: Request, res: Response) => {
    try {
      const { questionId } = req.params;

      // Convert questionId hex string to buffer
      const questionIdBuffer = Buffer.from(questionId.replace("0x", ""), "hex");

      // Fetch question data
      const questionResult = await fetchCallReadOnlyFunction({
        contractAddress,
        contractName,
        functionName: "get-question",
        functionArgs: [bufferCV(questionIdBuffer)],
        network: NETWORK,
        senderAddress: contractAddress,
      });

      const question = cvToValue(questionResult);

      if (!question || question.type === "none") {
        return res.status(404).json({
          success: false,
          error: "Question not found",
        });
      }

      // Fetch proposal
      const proposalResult = await fetchCallReadOnlyFunction({
        contractAddress,
        contractName,
        functionName: "get-proposal",
        functionArgs: [bufferCV(questionIdBuffer)],
        network: NETWORK,
        senderAddress: contractAddress,
      });

      const proposal = cvToValue(proposalResult);

      // Fetch dispute
      const disputeResult = await fetchCallReadOnlyFunction({
        contractAddress,
        contractName,
        functionName: "get-dispute",
        functionArgs: [bufferCV(questionIdBuffer)],
        network: NETWORK,
        senderAddress: contractAddress,
      });

      const dispute = cvToValue(disputeResult);

      // Fetch vote tally if disputed
      let voteTally = null;
      if (dispute && dispute.type !== "none") {
        const tallyResult = await fetchCallReadOnlyFunction({
          contractAddress,
          contractName,
          functionName: "get-vote-tally",
          functionArgs: [bufferCV(questionIdBuffer)],
          network: NETWORK,
          senderAddress: contractAddress,
        });
        voteTally = cvToValue(tallyResult);
      }

      // Fetch resolution
      const resolutionResult = await fetchCallReadOnlyFunction({
        contractAddress,
        contractName,
        functionName: "get-resolution",
        functionArgs: [bufferCV(questionIdBuffer)],
        network: NETWORK,
        senderAddress: contractAddress,
      });

      const resolution = cvToValue(resolutionResult);

      res.json({
        success: true,
        questionId,
        question: question.value,
        proposal: proposal.type !== "none" ? proposal.value : null,
        dispute: dispute.type !== "none" ? dispute.value : null,
        voteTally: voteTally?.type !== "none" ? voteTally.value : null,
        resolution: resolution.type !== "none" ? resolution.value : null,
      });
    } catch (error) {
      console.error("Error fetching question:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch question details",
      });
    }
  }
);

// Get user's vote on a specific question
oracleRoutes.get(
  "/questions/:questionId/vote/:address",
  async (req: Request, res: Response) => {
    try {
      const { questionId, address } = req.params;

      const questionIdBuffer = Buffer.from(questionId.replace("0x", ""), "hex");

      const voteResult = await fetchCallReadOnlyFunction({
        contractAddress,
        contractName,
        functionName: "get-user-vote",
        functionArgs: [bufferCV(questionIdBuffer), principalCV(address)],
        network: NETWORK,
        senderAddress: contractAddress,
      });

      const vote = cvToValue(voteResult);

      res.json({
        success: true,
        questionId,
        address,
        vote: vote.type !== "none" ? vote.value : null,
      });
    } catch (error) {
      console.error("Error fetching user vote:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch user vote",
      });
    }
  }
);

// Check if question is resolved
oracleRoutes.get(
  "/questions/:questionId/resolved",
  async (req: Request, res: Response) => {
    try {
      const { questionId } = req.params;

      const questionIdBuffer = Buffer.from(questionId.replace("0x", ""), "hex");

      const resolvedResult = await fetchCallReadOnlyFunction({
        contractAddress,
        contractName,
        functionName: "is-resolved",
        functionArgs: [bufferCV(questionIdBuffer)],
        network: NETWORK,
        senderAddress: contractAddress,
      });

      const isResolved = cvToValue(resolvedResult);

      res.json({
        success: true,
        questionId,
        resolved: isResolved,
      });
    } catch (error) {
      console.error("Error checking resolution status:", error);
      res.status(500).json({
        success: false,
        error: "Failed to check resolution status",
      });
    }
  }
);
