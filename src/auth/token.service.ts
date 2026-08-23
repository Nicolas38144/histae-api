import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import type { NewRefreshToken, StoredRefreshToken } from './auth.models';

export const ACCESS_TOKEN_ISSUER = 'histae-api';
export const ACCESS_TOKEN_AUDIENCE = 'histae-app';
export const ACCESS_TOKEN_TYPE = 'access';

@Injectable()
export class TokenService {
  constructor(private readonly config: ConfigService, private readonly jwt: JwtService) {}

  newRefreshToken(): NewRefreshToken {
    const jti = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const createdAt = new Date();
    return {
      id: randomUUID(),
      jti,
      plain: `${jti}:${secret}`,
      hash: createHash('sha256').update(secret).digest('hex'),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.config.jwt.refreshTtlMs),
    };
  }

  parseRefreshToken(value: string): { jti: string; hash: string } | undefined {
    const parts = value.split(':');
    if (parts.length !== 2 || !parts[1] || !/^[0-9a-f-]{36}$/i.test(parts[0])) return undefined;
    return { jti: parts[0], hash: createHash('sha256').update(parts[1]).digest('hex') };
  }

  isUsable(stored: StoredRefreshToken, expectedHash: string): boolean {
    const left = Buffer.from(stored.token_hash, 'utf8');
    const right = Buffer.from(expectedHash, 'utf8');
    return !stored.revoked && new Date(stored.expires_at).getTime() > Date.now() && left.length === right.length && timingSafeEqual(left, right);
  }

  accessToken(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, typ: ACCESS_TOKEN_TYPE },
      {
        algorithm: 'HS256',
        audience: ACCESS_TOKEN_AUDIENCE,
        issuer: ACCESS_TOKEN_ISSUER,
        expiresIn: Math.floor(this.config.jwt.accessTtlMs / 1_000),
      },
    );
  }
}
