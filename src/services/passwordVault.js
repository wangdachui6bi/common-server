import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { config } from "../config.js";

const ENCRYPTION_PREFIX = "vault:v1";
const ALGORITHM = "aes-256-gcm";

function getVaultKey() {
  const secret = String(config.jwtSecret || "").trim();
  if (!secret) {
    throw new Error(" JWT_SECRET is not configured");
  }

  return createHash("sha256").update(secret).digest();
}

export function encryptVaultSecret(value) {
  const plaintext = String(value ?? "");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getVaultKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptVaultSecret(payload) {
  const raw = String(payload || "");
  if (!raw) {
    return "";
  }

  const [prefix, version, ivText, authTagText, encryptedText] = raw.split(":");
  if (
    `${prefix}:${version}` !== ENCRYPTION_PREFIX ||
    !ivText ||
    !authTagText ||
    !encryptedText
  ) {
    throw new Error("Unsupported vault payload");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    getVaultKey(),
    Buffer.from(ivText, "base64"),
  );
  decipher.setAuthTag(Buffer.from(authTagText, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
