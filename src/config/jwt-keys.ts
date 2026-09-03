// Key IDs only select a locally configured key, never a URL or filesystem path.
export function jwtKeys(activeKid: string, secret: string, rawPreviousKeys: string): ReadonlyMap<string, string> {
  const invalid = () => new Error('config: JWT_ACTIVE_KID and JWT_PREVIOUS_KEYS must define distinct valid key IDs and secrets of at least 32 bytes');
  const validKid = (kid: string) => /^[A-Za-z0-9_-]{1,64}$/.test(kid);
  if (!validKid(activeKid) || Buffer.byteLength(secret) < 32 || rawPreviousKeys.length > 16_384) throw invalid();
  let previous: unknown;
  try { previous = JSON.parse(rawPreviousKeys); } catch { throw invalid(); }
  if (!previous || typeof previous !== 'object' || Array.isArray(previous) || Object.keys(previous).length > 4) throw invalid();
  const keys = new Map([[activeKid, secret]]);
  for (const [kid, value] of Object.entries(previous)) {
    if (!validKid(kid) || keys.has(kid) || typeof value !== 'string' || Buffer.byteLength(value) < 32
      || [...keys.values()].includes(value)) throw invalid();
    keys.set(kid, value);
  }
  return keys;
}
