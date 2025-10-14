import { verifyMessageSignatureRsv, hashMessage } from "@stacks/encryption";

/**
 * Compute order hash matching the Clarity contract's hash-order function
 *
 * Contract implementation:
 * (sha256 (concat
 *   (concat
 *     (concat
 *       (concat
 *         (concat
 *           (concat
 *             (unwrap-panic (to-consensus-buff? maker))
 *             (unwrap-panic (to-consensus-buff? taker))
 *           )
 *           position-id
 *         )
 *         (unwrap-panic (to-consensus-buff? maker-amount))
 *       )
 *       (unwrap-panic (to-consensus-buff? taker-amount))
 *     )
 *     (unwrap-panic (to-consensus-buff? salt))
 *   )
 *   (unwrap-panic (to-consensus-buff? expiration))
 * ))
 */
export function computeOrderHash(
  maker: string,
  taker: string,
  positionId: string,
  makerAmount: number,
  takerAmount: number,
  salt: string,
  expiration: number
): Buffer {
  // Create a deterministic order message
  // This should match the frontend's computeOrderHash function
  const orderMessage = JSON.stringify({
    maker,
    taker,
    positionId,
    makerAmount,
    takerAmount,
    salt,
    expiration,
  });

  // Hash the message using Stacks' hashMessage function
  const hash = hashMessage(orderMessage);
  return Buffer.from(hash);
}

/**
 * Verify a Stacks message signature
 * @param orderHash - The order hash to verify
 * @param signature - The signature in RSV format (65 bytes = 130 hex chars)
 * @param publicKey - The public key from the wallet that signed the message
 * @returns true if signature is valid
 */
export function verifyOrderSignature(
  orderHash: Buffer,
  signature: string,
  publicKey: string
): boolean {
  try {
    // Signature should be in hex format, RSV (65 bytes = 130 hex chars)
    if (signature.length !== 130) {
      console.error(
        `Invalid signature length: ${signature.length}, expected 130`
      );
      return false;
    }

    // Verify the signature using Stacks encryption library
    // verifyMessageSignatureRsv expects the actual public key (not address)
    const verified = verifyMessageSignatureRsv({
      message: orderHash.toString("hex"),
      signature,
      publicKey, // Use the actual public key from the wallet
    });

    return verified;
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

/**
 * Middleware to verify order signatures
 */
export async function verifyOrderSignatureMiddleware(orderData: {
  maker: string;
  taker?: string;
  positionId: string;
  makerAmount: number;
  takerAmount: number;
  salt: string;
  expiration: number;
  signature: string;
  publicKey: string;
}): Promise<{ valid: boolean; error?: string }> {
  const {
    maker,
    taker,
    positionId,
    makerAmount,
    takerAmount,
    salt,
    expiration,
    signature,
    publicKey,
  } = orderData;

  // Validation
  if (!signature) {
    return { valid: false, error: "Signature is required" };
  }

  if (!publicKey) {
    return { valid: false, error: "Public key is required" };
  }

  if (!maker) {
    return { valid: false, error: "Maker address is required" };
  }

  // Use maker as taker if taker is not specified (for limit orders)
  const takerAddress = taker || maker;

  try {
    // Compute order hash
    const orderHash = computeOrderHash(
      maker,
      takerAddress,
      positionId,
      makerAmount,
      takerAmount,
      salt,
      expiration
    );

    // Verify signature using the public key from the wallet
    const isValid = verifyOrderSignature(orderHash, signature, publicKey);

    if (!isValid) {
      return { valid: false, error: "Invalid signature" };
    }

    return { valid: true };
  } catch (error: any) {
    console.error("Order signature verification failed:", error);
    return {
      valid: false,
      error: error.message || "Signature verification failed",
    };
  }
}
