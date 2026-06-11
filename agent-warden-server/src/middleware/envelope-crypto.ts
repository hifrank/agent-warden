/**
 * Envelope encryption helpers using AES-256-GCM.
 * KEK (Key Encryption Key) is stored in Azure Key Vault;
 * encrypted secrets are stored in Cosmos DB.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16;

interface EncryptedBlob {
  /** Base64-encoded IV + ciphertext + auth tag */
  data: string;
  /** Key vault name (for provenance) */
  vault: string;
  /** KEK secret name in Key Vault */
  kekName: string;
}

/**
 * Encrypt a plaintext value using a KEK fetched from Key Vault.
 */
export async function envelopeEncrypt(
  plaintext: string,
  vaultUrl: string,
  kekSecretName: string,
): Promise<EncryptedBlob> {
  const kek = await fetchKek(vaultUrl, kekSecretName);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, kek, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Pack: IV (12) + ciphertext (N) + tag (16)
  const packed = Buffer.concat([iv, encrypted, tag]);

  return {
    data: packed.toString("base64"),
    vault: new URL(vaultUrl).hostname.split(".")[0],
    kekName: kekSecretName,
  };
}

/**
 * Decrypt an envelope-encrypted blob using a KEK from Key Vault.
 */
export async function envelopeDecrypt(
  blob: EncryptedBlob,
  vaultUrl: string,
): Promise<string> {
  const kek = await fetchKek(vaultUrl, blob.kekName);
  const packed = Buffer.from(blob.data, "base64");

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(packed.length - TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, kek, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

// ── KEK cache (in-memory, per-process) ──

const kekCache = new Map<string, { key: Buffer; expiresAt: number }>();
const KEK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchKek(vaultUrl: string, secretName: string): Promise<Buffer> {
  const cacheKey = `${vaultUrl}#${secretName}`;
  const cached = kekCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  const secret = await client.getSecret(secretName);
  if (!secret.value) {
    throw new Error(`KEK secret ${secretName} in ${vaultUrl} has no value`);
  }

  // KEK is stored as hex string (32 bytes = 64 hex chars)
  const key = Buffer.from(secret.value, "hex");
  if (key.length !== 32) {
    throw new Error(`KEK ${secretName} must be 32 bytes (256-bit), got ${key.length}`);
  }

  kekCache.set(cacheKey, { key, expiresAt: Date.now() + KEK_CACHE_TTL_MS });
  return key;
}

/**
 * Generate a random 256-bit KEK as hex string (for storing in Key Vault).
 */
export function generateKekValue(): string {
  return randomBytes(32).toString("hex");
}
