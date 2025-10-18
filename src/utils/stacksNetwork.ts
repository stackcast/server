import { createNetwork, type StacksNetworkName } from "@stacks/network";

const networkName =
  (process.env.STACKS_NETWORK as StacksNetworkName | undefined) || "testnet";

export const stacksNetwork = process.env.STACKS_API_URL
  ? createNetwork({
      network: networkName,
      client: { baseUrl: process.env.STACKS_API_URL },
    })
  : createNetwork(networkName);

export const stacksApiBaseUrl = stacksNetwork.client.baseUrl;
