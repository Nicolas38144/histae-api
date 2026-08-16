import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

type PlanRow = {
  code: string;
  display_name: string;
  monthly_price_cents: number;
  annual_price_cents: number;
  currency: string;
  weekly_continuation_limit: number | null;
  trial_days: number;
  feature_code: string | null;
  feature_name: string | null;
  feature_description: string | null;
  feature_value: unknown | null;
};

@Injectable()
export class PlansRepository {
  constructor(private readonly database: DatabaseService) {}

  async listActive(): Promise<PlanRow[]> {
    return (await this.database.query<PlanRow>(`
      SELECT plan.code, plan.display_name, plan.monthly_price_cents, plan.annual_price_cents, plan.currency,
        plan.weekly_continuation_limit, plan.trial_days, feature.feature_code, feature.display_name AS feature_name,
        feature.description AS feature_description, feature.feature_value
      FROM subscription_plan AS plan
      LEFT JOIN subscription_plan_feature AS feature ON feature.plan_code = plan.code
      WHERE plan.is_active = true
      ORDER BY plan.monthly_price_cents, plan.code, feature.sort_order, feature.feature_code
    `)).rows;
  }
}
