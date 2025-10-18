export const PRICE_SCALE = 1_000_000;
export const MID_PRICE_SPREAD_THRESHOLD = 100_000; // 0.10 sBTC per token

export function deriveYesNoPrices(options: {
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  currentYesPrice?: number;
}) {
  const { bestBid, bestAsk, lastTradePrice, currentYesPrice } = options;

  let yesPrice =
    typeof currentYesPrice === "number" ? currentYesPrice : PRICE_SCALE / 2;

  if (bestBid !== undefined && bestAsk !== undefined) {
    const spread = Math.abs(bestAsk - bestBid);
    if (spread <= MID_PRICE_SPREAD_THRESHOLD) {
      yesPrice = Math.round((bestBid + bestAsk) / 2);
    } else if (lastTradePrice !== undefined) {
      yesPrice = lastTradePrice;
    } else {
      yesPrice = bestBid;
    }
  } else if (bestBid !== undefined) {
    yesPrice = bestBid;
  } else if (bestAsk !== undefined) {
    yesPrice = bestAsk;
  } else if (lastTradePrice !== undefined) {
    yesPrice = lastTradePrice;
  }

  yesPrice = Math.max(0, Math.min(PRICE_SCALE, yesPrice));
  const noPrice = Math.max(0, Math.min(PRICE_SCALE, PRICE_SCALE - yesPrice));

  return { yesPrice, noPrice };
}
