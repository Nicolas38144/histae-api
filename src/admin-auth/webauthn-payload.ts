import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { apiError } from '../common/api-error';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

export function registrationCredential(value: Record<string, unknown>): RegistrationResponseJSON {
  exactKeys(value, ['id', 'rawId', 'type', 'response', 'authenticatorAttachment', 'clientExtensionResults']);
  const response = record(value.response);
  exactKeys(response, ['clientDataJSON', 'attestationObject', 'authenticatorData', 'transports', 'publicKeyAlgorithm', 'publicKey']);
  const result = {
    id: encoded(value.id, 2048),
    rawId: encoded(value.rawId, 2048),
    type: publicKeyType(value.type),
    response: {
      clientDataJSON: encoded(response.clientDataJSON, 16_384),
      attestationObject: encoded(response.attestationObject, 131_072),
      ...(response.authenticatorData === undefined ? {} : { authenticatorData: encoded(response.authenticatorData, 16_384) }),
      ...(response.publicKey === undefined ? {} : { publicKey: encoded(response.publicKey, 16_384) }),
      ...(response.publicKeyAlgorithm === undefined ? {} : { publicKeyAlgorithm: integer(response.publicKeyAlgorithm) }),
      ...(response.transports === undefined ? {} : { transports: transports(response.transports) }),
    },
    clientExtensionResults: extensionResults(value.clientExtensionResults),
    ...(value.authenticatorAttachment === undefined ? {} : { authenticatorAttachment: attachment(value.authenticatorAttachment) }),
  } satisfies RegistrationResponseJSON;
  if (result.id !== result.rawId) invalid();
  return result;
}

export function authenticationCredential(value: Record<string, unknown>): AuthenticationResponseJSON {
  exactKeys(value, ['id', 'rawId', 'type', 'response', 'authenticatorAttachment', 'clientExtensionResults']);
  const response = record(value.response);
  exactKeys(response, ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle']);
  const result = {
    id: encoded(value.id, 2048),
    rawId: encoded(value.rawId, 2048),
    type: publicKeyType(value.type),
    response: {
      clientDataJSON: encoded(response.clientDataJSON, 16_384),
      authenticatorData: encoded(response.authenticatorData, 16_384),
      signature: encoded(response.signature, 16_384),
      ...(response.userHandle === undefined || response.userHandle === null
        ? {}
        : { userHandle: encoded(response.userHandle, 2048) }),
    },
    clientExtensionResults: extensionResults(value.clientExtensionResults),
    ...(value.authenticatorAttachment === undefined ? {} : { authenticatorAttachment: attachment(value.authenticatorAttachment) }),
  } satisfies AuthenticationResponseJSON;
  if (result.id !== result.rawId) invalid();
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) invalid();
}

function encoded(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || !BASE64URL.test(value)) invalid();
  return value;
}

function publicKeyType(value: unknown): 'public-key' {
  if (value !== 'public-key') invalid();
  return value;
}

function attachment(value: unknown): 'cross-platform' | 'platform' {
  if (value !== 'cross-platform' && value !== 'platform') invalid();
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid();
  return value;
}

function transports(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > TRANSPORTS.size
    || value.some((item) => typeof item !== 'string' || !TRANSPORTS.has(item))) invalid();
  return [...new Set(value as string[])];
}

function extensionResults(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (JSON.stringify(result).length > 8_192) invalid();
  return result;
}

function invalid(): never {
  throw apiError(400, 'invalid_webauthn_payload', 'The WebAuthn response is invalid.');
}
