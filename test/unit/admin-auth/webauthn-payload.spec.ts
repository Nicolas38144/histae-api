import { authenticationCredential, registrationCredential } from '../../../src/admin-auth/webauthn-payload';

describe('WebAuthn response parser', () => {
  it('accepts the browser authentication shape and preserves no unknown fields', () => {
    expect(authenticationCredential({
      id: 'credential-id',
      rawId: 'credential-id',
      type: 'public-key',
      response: {
        clientDataJSON: 'Y2xpZW50',
        authenticatorData: 'YXV0aGVudGljYXRvcg',
        signature: 'c2lnbmF0dXJl',
        userHandle: null,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    })).toEqual(expect.objectContaining({ id: 'credential-id', type: 'public-key' }));
  });

  it('rejects an unknown top-level property', () => {
    expect(() => authenticationCredential({
      id: 'credential-id',
      rawId: 'credential-id',
      type: 'public-key',
      response: {
        clientDataJSON: 'Y2xpZW50',
        authenticatorData: 'YXV0aGVudGljYXRvcg',
        signature: 'c2lnbmF0dXJl',
      },
      clientExtensionResults: {},
      injected: true,
    })).toThrow(expect.objectContaining({ code: 'invalid_webauthn_payload' }));
  });

  it('rejects mismatched credential IDs and oversized extension output', () => {
    expect(() => registrationCredential({
      id: 'credential-one',
      rawId: 'credential-two',
      type: 'public-key',
      response: { clientDataJSON: 'YQ', attestationObject: 'Yg' },
      clientExtensionResults: {},
    })).toThrow(expect.objectContaining({ code: 'invalid_webauthn_payload' }));
    expect(() => authenticationCredential({
      id: 'credential-id',
      rawId: 'credential-id',
      type: 'public-key',
      response: { clientDataJSON: 'YQ', authenticatorData: 'Yg', signature: 'Yw' },
      clientExtensionResults: { value: 'x'.repeat(8_192) },
    })).toThrow(expect.objectContaining({ code: 'invalid_webauthn_payload' }));
  });
});
