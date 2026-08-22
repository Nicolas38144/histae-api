import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import type { NotificationType } from './mobile.models';
import { MobileRepository } from './mobile.repository';

type AccessToken = { value: string; expiresAt: number };

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private accessToken?: AccessToken;

  constructor(
    private readonly config: ConfigService,
    private readonly mobile: MobileRepository,
  ) {}

  async sendToUser(userId: string, type: NotificationType, data: Record<string, string>): Promise<void> {
    if (this.config.push.provider === 'disabled') return;
    const tokens = await this.mobile.tokensForUser(userId);
    await Promise.all(tokens.map((token) => this.send(token, type, data)));
  }

  private async send(token: string, type: NotificationType, data: Record<string, string>): Promise<void> {
    try {
      const accessToken = await this.googleAccessToken();
      const copy = type === 'new_match'
        ? { title: 'Nouveau match', body: 'Vous avez un nouveau match sur Histae.' }
        : { title: 'Nouveau message', body: 'Vous avez reçu un nouveau message sur Histae.' };
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.push.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token, notification: copy, data: { type, ...data } } }),
          signal: AbortSignal.timeout(this.config.push.timeoutMillis),
        },
      );
      if (response.ok) return;
      const body = await response.json().catch(() => undefined) as FcmErrorResponse | undefined;
      if (isUnregistered(body)) {
        await this.mobile.removeToken(token);
        return;
      }
      this.logger.warn(`FCM delivery failed with HTTP ${response.status}`);
    } catch (error) {
      this.logger.warn(`FCM delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async googleAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const now = Math.floor(Date.now() / 1_000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(JSON.stringify({
      iss: this.config.push.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: this.config.push.tokenUri,
      iat: now,
      exp: now + 3_600,
    }));
    const unsigned = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const assertion = `${unsigned}.${signer.sign(this.config.push.privateKey).toString('base64url')}`;
    const response = await fetch(this.config.push.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(this.config.push.timeoutMillis),
    });
    const body = await response.json().catch(() => undefined) as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (!response.ok || typeof body?.access_token !== 'string') throw new Error(`OAuth token request failed with HTTP ${response.status}`);
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3_600;
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1_000 };
    return body.access_token;
  }
}

type FcmErrorResponse = { error?: { status?: string; details?: Array<{ errorCode?: string }> } };

function isUnregistered(body: FcmErrorResponse | undefined): boolean {
  return body?.error?.status === 'NOT_FOUND'
    || body?.error?.details?.some((detail) => detail.errorCode === 'UNREGISTERED') === true;
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
