import { Injectable } from '@nestjs/common';
import { PlansRepository } from './plans.repository';

type PlanFeature = { code: string; display_name: string | null; description: string | null; feature_value: unknown | null };
export type SubscriptionPlan = {
  code: string;
  display_name: string;
  monthly_price_cents: number;
  annual_price_cents: number;
  currency: string;
  trial_days: number;
  weekly_continuation_limit?: number;
  features: PlanFeature[];
};

@Injectable()
export class PlansService {
  constructor(private readonly plansRepository: PlansRepository) {}

  async list(): Promise<SubscriptionPlan[]> {
    const rows = await this.plansRepository.listActive();
    const plans = new Map<string, SubscriptionPlan>();
    for (const row of rows) {
      let plan = plans.get(row.code);
      if (!plan) {
        plan = {
          code: row.code, display_name: row.display_name, monthly_price_cents: row.monthly_price_cents,
          annual_price_cents: row.annual_price_cents, currency: row.currency, trial_days: row.trial_days, features: [],
        };
        if (row.weekly_continuation_limit !== null) plan.weekly_continuation_limit = row.weekly_continuation_limit;
        plans.set(row.code, plan);
      }
      if (row.feature_code !== null) {
        plan.features.push({
          code: row.feature_code, display_name: row.feature_name, description: row.feature_description, feature_value: row.feature_value,
        });
      }
    }
    return [...plans.values()];
  }
}
