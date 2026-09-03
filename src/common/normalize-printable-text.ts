export function normalizePrintableText(
  value: string,
  limits: { minLength: number; maxLength: number; maxBytes?: number },
): string | undefined {
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length < limits.minLength || normalized.length > limits.maxLength
    || (limits.maxBytes !== undefined && Buffer.byteLength(normalized) > limits.maxBytes)
    || [...normalized].some(isControlCharacter)) {
    return undefined;
  }
  return normalized;
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
}
