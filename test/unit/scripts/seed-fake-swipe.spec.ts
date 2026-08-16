import { generateSwipePlans } from '../../../scripts/seed-fake-swipe';
import type { SeedUser } from '../../../scripts/seed-fake-swipe';

describe('fake swipe seed planner', () => {
  it('creates exactly 20 distinct swipes per user without reciprocal likes', () => {
    const users: SeedUser[] = Array.from({ length: 400 }, (_, index) => ({
      seedNumber: index + 1,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      sex: index < 24 ? 'other' : index % 2 === 0 ? 'male' : 'female',
      latitude: 48.8566,
      longitude: 2.3522,
      accessToken: 'test-token',
    }));

    const plans = generateSwipePlans(users);
    const targetsByActor = new Map<string, Set<string>>();
    const pairs = new Map<string, typeof plans>();
    for (const plan of plans) {
      const targets = targetsByActor.get(plan.actor.id) ?? new Set<string>();
      targets.add(plan.target.id);
      targetsByActor.set(plan.actor.id, targets);
      const key = [plan.actor.id, plan.target.id].sort().join(':');
      pairs.set(key, [...(pairs.get(key) ?? []), plan]);
    }

    expect(plans).toHaveLength(8_000);
    expect(plans.filter((plan) => plan.decision === 'like')).toHaveLength(4_000);
    expect(plans.filter((plan) => plan.decision === 'pass')).toHaveLength(4_000);
    expect([...targetsByActor.values()].every((targets) => targets.size === 20)).toBe(true);
    expect([...pairs.values()].every((pair) => (
      pair.length === 2 && pair.filter((plan) => plan.decision === 'like').length === 1
    ))).toBe(true);
  });
});
