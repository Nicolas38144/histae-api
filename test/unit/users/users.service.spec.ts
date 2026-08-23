import { UsersService } from '../../../src/users/users.service';

describe('UsersService consent enforcement', () => {
  const noOpBilling = { deleteCustomerForAccount: jest.fn().mockResolvedValue(undefined) };
  const config = { legal: {
    termsVersion: 'terms-v1',
    privacyVersion: 'privacy-v1',
    sensitiveDataConsentVersion: 'sensitive-v1',
    locationConsentVersion: 'location-v1',
    termsUrl: 'https://histae.test/legal/terms',
    privacyUrl: 'https://histae.test/legal/privacy',
    sensitiveDataConsentUrl: 'https://histae.test/legal/sensitive-data',
    locationConsentUrl: 'https://histae.test/legal/location',
  }, accountDeletionTokenTtlMs: 10 * 60 * 1_000 };

  it('does not persist sensitive profile data without the required consents', async () => {
    const repository = {
      activeLegalChoices: jest.fn().mockResolvedValue([
        { consent_type: 'terms_of_service_acceptance', document_version: 'terms-v1' },
        { consent_type: 'privacy_notice_acknowledgement', document_version: 'privacy-v1' },
      ]),
      upsertProfile: jest.fn(),
    };
    const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);

    await expect(service.updateProfile('user-id', {
      firstname: 'Nicolas', birthdate: '1990-01-01', sex: 'male', bio: null, photo: null,
    })).rejects.toEqual(expect.objectContaining({ status: 403, code: 'required_consent_missing' }));
    expect(repository.upsertProfile).not.toHaveBeenCalled();
  });

  it('records legal document versions with consent updates and returns the current state', async () => {
    const repository = {
      recordConsents: jest.fn().mockResolvedValue(true),
      currentConsents: jest.fn().mockResolvedValue([
        {
          consent_type: 'terms_of_service_acceptance', granted: true, document_version: 'terms-v1',
          granted_at: new Date('2030-01-01T00:00:00.000Z'), withdrawn_at: null,
        },
      ]),
    };
    const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);

    await expect(service.updateConsents('user-id', [{ consent_type: 'terms_of_service_acceptance', granted: true }], '127.0.0.1', 'test-agent'))
      .resolves.toEqual(expect.objectContaining({
        onboarding_complete: false,
        required_actions: ['privacy_notice_acknowledgement'],
        consents: expect.arrayContaining([
          expect.objectContaining({ consent_type: 'terms_of_service_acceptance', granted: true, document_version: 'terms-v1' }),
          expect.objectContaining({
            consent_type: 'privacy_notice_acknowledgement',
            granted: false,
            required_document_version: 'privacy-v1',
            document_url: 'https://histae.test/legal/privacy',
          }),
        ]),
      }));
    expect(repository.recordConsents).toHaveBeenCalledWith(
      'user-id',
      [{ consent_type: 'terms_of_service_acceptance', granted: true, document_version: 'terms-v1' }],
      '127.0.0.1',
      'test-agent',
    );
  });

  it('requires the current legal text version before persisting profile data', async () => {
    const repository = {
      activeLegalChoices: jest.fn().mockResolvedValue([
        { consent_type: 'terms_of_service_acceptance', document_version: 'obsolete-terms' },
        { consent_type: 'privacy_notice_acknowledgement', document_version: 'privacy-v1' },
      ]),
      upsertProfile: jest.fn(),
    };
    const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);

    await expect(service.updateProfile('user-id', {
      firstname: 'Nicolas', birthdate: '1990-01-01', sex: null, bio: null, photo: null,
    })).rejects.toEqual(expect.objectContaining({ status: 403, code: 'required_consent_missing' }));
    expect(repository.upsertProfile).not.toHaveBeenCalled();
  });

  it('records a version for each actual consent text', async () => {
    const repository = {
      recordConsents: jest.fn().mockResolvedValue(true),
      currentConsents: jest.fn().mockResolvedValue([]),
    };
    const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);

    await service.updateConsents('user-id', [
      { consent_type: 'sensitive_data_consent', granted: true },
      { consent_type: 'location_consent', granted: true },
    ], '127.0.0.1', 'test-agent');

    expect(repository.recordConsents).toHaveBeenCalledWith('user-id', [
      { consent_type: 'sensitive_data_consent', granted: true, document_version: 'sensitive-v1' },
      { consent_type: 'location_consent', granted: true, document_version: 'location-v1' },
    ], '127.0.0.1', 'test-agent');
  });

  it('does not model contract acceptance or privacy acknowledgement as withdrawable consent', async () => {
    const repository = { recordConsents: jest.fn() };
    const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);

    await expect(service.updateConsents('user-id', [
      { consent_type: 'terms_of_service_acceptance', granted: false },
    ], '127.0.0.1', 'test-agent')).rejects.toEqual(expect.objectContaining({
      status: 400,
      code: 'invalid_consent_payload',
    }));
    expect(repository.recordConsents).not.toHaveBeenCalled();
  });

  it('reports onboarding complete only for the current mandatory document versions', async () => {
    const repository = {
      currentConsents: jest.fn().mockResolvedValue([
        {
          consent_type: 'terms_of_service_acceptance', granted: true, document_version: 'terms-v1',
          granted_at: new Date('2030-01-01T00:00:00.000Z'), withdrawn_at: null,
        },
        {
          consent_type: 'privacy_notice_acknowledgement', granted: true, document_version: 'privacy-v1',
          granted_at: new Date('2030-01-01T00:00:01.000Z'), withdrawn_at: null,
        },
      ]),
    };
    const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);

    await expect(service.getConsents('user-id')).resolves.toEqual(expect.objectContaining({
      onboarding_complete: true,
      required_actions: [],
    }));
  });

  it.each(['2000-02-30', '2001-13-01', '2001-00-10', '2001-01-00', '2001-1-01', '2001-01-01T00:00:00Z'])(
    'rejects the invalid calendar birthdate %s before persistence',
    async (birthdate) => {
      const repository = { upsertProfile: jest.fn(), activeLegalChoices: jest.fn() };
      const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);
      await expect(service.updateProfile('user-id', {
        firstname: 'Nicolas', birthdate, sex: null, bio: null, photo: null,
      })).rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_profile' }));
      expect(repository.upsertProfile).not.toHaveBeenCalled();
    },
  );

  it('rejects an unencrypted profile photo URL before persistence', async () => {
    const repository = {
      upsertProfile: jest.fn(),
      activeLegalChoices: jest.fn().mockResolvedValue([
        { consent_type: 'terms_of_service_acceptance', document_version: 'terms-v1' },
        { consent_type: 'privacy_notice_acknowledgement', document_version: 'privacy-v1' },
      ]),
    };
    const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);

    await expect(service.updateProfile('user-id', {
      firstname: 'Nicolas', birthdate: '1990-01-01', sex: null, bio: null,
      photo: 'http://cdn.example.test/profile.jpg',
    })).rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_profile' }));
    expect(repository.upsertProfile).not.toHaveBeenCalled();
  });

  it('deletes Scylla discovery data before anonymizing the PostgreSQL account', async () => {
    const calls: string[] = [];
    const repository = { anonymize: jest.fn(async () => { calls.push('postgres'); }) };
    const discovery = { deleteUserData: jest.fn(async () => { calls.push('scylla'); }) };
    const service = new UsersService(repository as never, config as never, discovery as never, noOpBilling as never);

    await service.anonymize('user-id');

    expect(calls).toEqual(['scylla', 'postgres']);
  });

  it('deletes the Stripe customer before erasing the remaining account stores', async () => {
    const calls: string[] = [];
    const repository = { anonymize: jest.fn(async () => { calls.push('postgres'); }) };
    const discovery = { deleteUserData: jest.fn(async () => { calls.push('scylla'); }) };
    const billing = { deleteCustomerForAccount: jest.fn(async () => { calls.push('stripe'); }) };
    const service = new UsersService(repository as never, config as never, discovery as never, billing as never);

    await service.anonymize('user-id');

    expect(calls).toEqual(['stripe', 'scylla', 'postgres']);
  });

  it('issues a short-lived deletion token while storing only its hash', async () => {
    const repository = { replaceDeletionToken: jest.fn().mockResolvedValue(true) };
    const service = new UsersService(repository as never, config as never, {} as never, noOpBilling as never);

    const result = await service.issueDeletionToken('user-id');

    expect(result.confirmation_token).toMatch(/^[0-9a-f-]{36}:[A-Za-z0-9_-]{43}$/);
    expect(result.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(repository.replaceDeletionToken).toHaveBeenCalledWith(
      'user-id',
      result.confirmation_token.split(':')[0],
      expect.stringMatching(/^[0-9a-f]{64}$/),
      result.expires_at,
    );
    expect(repository.replaceDeletionToken.mock.calls[0][2]).not.toBe(result.confirmation_token);
  });

  it('consumes a valid one-time token before erasing Scylla and PostgreSQL data', async () => {
    const calls: string[] = [];
    const repository = {
      replaceDeletionToken: jest.fn().mockResolvedValue(true),
      consumeDeletionToken: jest.fn(async () => { calls.push('token'); return true; }),
      anonymize: jest.fn(async () => { calls.push('postgres'); }),
    };
    const discovery = { deleteUserData: jest.fn(async () => { calls.push('scylla'); }) };
    const service = new UsersService(repository as never, config as never, discovery as never, noOpBilling as never);
    const { confirmation_token: token } = await service.issueDeletionToken('user-id');

    await service.confirmAnonymize('user-id', token);

    expect(calls).toEqual(['token', 'scylla', 'postgres']);
    expect(repository.consumeDeletionToken).toHaveBeenCalledWith(
      'user-id',
      token.split(':')[0],
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.any(Date),
    );
  });

  it('rejects a malformed deletion token without erasing account data', async () => {
    const repository = { consumeDeletionToken: jest.fn(), anonymize: jest.fn() };
    const discovery = { deleteUserData: jest.fn() };
    const service = new UsersService(repository as never, config as never, discovery as never, noOpBilling as never);

    await expect(service.confirmAnonymize('user-id', 'not-a-token')).rejects.toEqual(expect.objectContaining({
      status: 401,
      code: 'invalid_or_expired_deletion_token',
    }));
    expect(repository.consumeDeletionToken).not.toHaveBeenCalled();
    expect(discovery.deleteUserData).not.toHaveBeenCalled();
    expect(repository.anonymize).not.toHaveBeenCalled();
  });
});
