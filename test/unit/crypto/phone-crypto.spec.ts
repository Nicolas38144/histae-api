import { encryptPhone, hmacSha256, parsePhoneKey } from '../../../src/crypto/phone-crypto';

describe('phone crypto', () => {
  const key = 'k'.repeat(32);

  it('uses AES-256-GCM with random nonces and without retaining plaintext', () => {
    const phone = '+33612345678';
    const first = encryptPhone(phone, key);
    const second = encryptPhone(phone, key);
    expect(first.toString('utf8')).not.toContain(phone);
    expect(first).not.toEqual(second);
    expect(first.length).toBe(12 + Buffer.byteLength(phone) + 16);
  });

  it('accepts a raw 32-byte hexadecimal-looking key and makes deterministic HMACs', () => {
    expect(parsePhoneKey('a'.repeat(32))).toHaveLength(32);
    expect(hmacSha256('+33612345678', key)).toBe(hmacSha256('+33612345678', key));
  });
});
