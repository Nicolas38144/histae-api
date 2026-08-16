import { createCipheriv, createHmac, randomBytes } from 'node:crypto';

export function parsePhoneKey(value: string): Buffer {
  const hex = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : undefined;
  if (hex?.length === 32) return hex;
  const raw = Buffer.from(value, 'utf8');
  if (raw.length === 32) return raw;
  throw new Error('encryption key must be exactly 32 bytes for AES-256');
}

export function encryptPhone(phone: string, keyValue: string): Buffer {
  const key = parsePhoneKey(keyValue);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([nonce, ciphertext]);
}

export function hmacSha256(value: string, keyValue: string): string {
  return createHmac('sha256', parsePhoneKey(keyValue)).update(value, 'utf8').digest('hex');
}
