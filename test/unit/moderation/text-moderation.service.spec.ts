import { TextModerationService } from '../../../src/moderation/text-moderation.service';

describe('TextModerationService', () => {
  const service = new TextModerationService();

  it('automatically approves ordinary profile text', () => {
    expect(service.analyze('J’aime cuisiner et marcher en forêt.')).toEqual({
      status: 'approved',
      reasonCodes: [],
      policyVersion: 'text_rules_v1',
    });
  });

  it.each([
    ['Écris-moi sur moi@example.com', 'personal_contact'],
    ['Quel abruti, vraiment.', 'insult'],
    ['Je cherche des nudes', 'sexual_content'],
    ['PROMO crypto, contacte-moi vite', 'spam'],
  ] as const)('sends %s to review as %s without automatically rejecting it', (text, reason) => {
    const decision = service.analyze(text);
    expect(decision.status).toBe('pending');
    expect(decision.reasonCodes).toContain(reason);
  });
});
