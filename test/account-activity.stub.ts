import type { AccountActivityService, AssertActivity } from '../src/database/account-activity.service';

// Domain-only tests do not use PostgreSQL. Real advisory locking is covered by
// postgres.erasure.integration.spec.ts, not simulated by this explicit stub.
export const accountActivityStub = {
  run: <T>(_ids: string[], work: (assertHeld: AssertActivity) => Promise<T>): Promise<T> => work(() => {}),
  runExisting: <T>(_ids: string[], work: (assertHeld: AssertActivity) => Promise<T>): Promise<T> => work(() => {}),
} as AccountActivityService;
