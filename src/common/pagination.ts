import { apiError } from './api-error';

export type KeysetCursor = { at: string; id: string };
export type CursorPage<T> = { items: T[]; next_cursor: string | null };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function decodeCursor(value?: string): KeysetCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || !('at' in decoded) || !('id' in decoded)
      || typeof decoded.at !== 'string' || typeof decoded.id !== 'string' || !UUID_PATTERN.test(decoded.id)) {
      throw new Error('invalid cursor shape');
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(decoded.at)
      || !Number.isFinite(new Date(decoded.at).getTime())) throw new Error('invalid cursor timestamp');
    return { at: decoded.at, id: decoded.id };
  } catch (error) {
    throw apiError(400, 'invalid_cursor', 'The pagination cursor is invalid.', error);
  }
}

export function cursorPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  timestamp: (row: T) => Date | string,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor(timestamp(last), last.id) : null,
  };
}

function encodeCursor(at: Date | string, id: string): string {
  return Buffer.from(JSON.stringify({ at: at instanceof Date ? at.toISOString() : at, id }), 'utf8').toString('base64url');
}
