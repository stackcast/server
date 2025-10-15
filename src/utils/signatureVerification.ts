import { verifyMessageSignatureRsv } from "@stacks/encryption";
import { serializeCV, standardPrincipalCV, uintCV, bufferCV } from "@stacks/transactions";
import { createHash } from "crypto";

/**
 * Compute order hash matching the Clarity contract's hash-order function
 *
 * Contract implementation (ctf-exchange.clar:46-78):
 * (sha256 (concat
 *   (concat
 *     (concat
 *       (concat
 *         (concat
 *           (concat
 *             (concat
 *               (unwrap-panic (to-consensus-buff? maker))
 *               (unwrap-panic (to-consensus-buff? taker))
 *             )
 *             maker-position-id
 *           )
 *           taker-position-id
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
  makerPositionId: string,
  takerPositionId: string,
  makerAmount: number,
  takerAmount: number,
  salt: string,
  expiration: number
): Buffer {
  // Validate inputs
  if (!/^\d+$/.test(salt)) {
    throw new Error("Salt must be a numeric string");
  }

  // Serialize each field to Clarity consensus buffers
  const makerBuff = Buffer.from(serializeCV(standardPrincipalCV(maker)));
  const takerBuff = Buffer.from(serializeCV(standardPrincipalCV(taker)));

  // Position IDs should be 32-byte hex strings (64 hex chars)
  const makerPositionIdBuff = Buffer.from(makerPositionId, "hex");
  const takerPositionIdBuff = Buffer.from(takerPositionId, "hex");

  if (makerPositionIdBuff.length !== 32) {
    throw new Error(`Maker position ID must be 32 bytes (64 hex chars), got ${makerPositionIdBuff.length} bytes`);
  }
  if (takerPositionIdBuff.length !== 32) {
    throw new Error(`Taker position ID must be 32 bytes (64 hex chars), got ${takerPositionIdBuff.length} bytes`);
  }

  const makerAmountBuff = Buffer.from(serializeCV(uintCV(makerAmount)));
  const takerAmountBuff = Buffer.from(serializeCV(uintCV(takerAmount)));
  const saltBuff = Buffer.from(serializeCV(uintCV(BigInt(salt))));
  const expirationBuff = Buffer.from(serializeCV(uintCV(expiration)));

  // Concatenate all buffers in the exact order as the contract
  const concatenated = Buffer.concat([
    makerBuff,
    takerBuff,
    makerPositionIdBuff,
    takerPositionIdBuff,
    makerAmountBuff,
    takerAmountBuff,
    saltBuff,
    expirationBuff,
  ]);

  // Hash with SHA-256 (not Stacks' hashMessage which adds prefixes)
  const hash = createHash("sha256").update(concatenated).digest();

  return hash;
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
  makerPositionId: string;
  takerPositionId: string;
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
    makerPositionId,
    takerPositionId,
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

  if (!makerPositionId) {
    return { valid: false, error: "Maker position ID is required" };
  }

  if (!takerPositionId) {
    return { valid: false, error: "Taker position ID is required" };
  }

  // Use maker as taker if taker is not specified (for limit orders)
  const takerAddress = taker || maker;

  try {
    // Compute order hash
    const orderHash = computeOrderHash(
      maker,
      takerAddress,
      makerPositionId,
      takerPositionId,
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
