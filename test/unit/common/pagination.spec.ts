import { randomUUID } from 'node:crypto';
import { cursorPage, decodeCursor } from '../../../src/common/pagination';

describe('cursor pagination', () => {
  it('returns an opaque cursor for the last visible row', () => {
    const rows = [
      { id: randomUUID(), created_at: new Date('2030-01-03T00:00:00.000Z') },
      { id: randomUUID(), created_at: new Date('2030-01-02T00:00:00.000Z') },
      { id: randomUUID(), created_at: new Date('2030-01-01T00:00:00.000Z') },
    ];

    const page = cursorPage(rows, 2, (row) => row.created_at);

    expect(page.items).toEqual(rows.slice(0, 2));
    expect(decodeCursor(page.next_cursor!)).toEqual({ at: rows[1].created_at.toISOString(), id: rows[1].id });
  });

  it('rejects malformed and non-UUID cursors', () => {
    const malformed = Buffer.from(JSON.stringify({ at: '2030-01-01T00:00:00.000Z', id: 'not-a-uuid' })).toString('base64url');
    expect(() => decodeCursor(malformed)).toThrow(expect.objectContaining({ code: 'invalid_cursor', status: 400 }));
    expect(() => decodeCursor('not-json')).toThrow(expect.objectContaining({ code: 'invalid_cursor', status: 400 }));
  });
});
