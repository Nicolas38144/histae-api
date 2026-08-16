import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import type { NewRefreshToken, StoredRefreshToken } from './auth.models';

@Injectable()
export class TokenService {
  constructor(private readonly config: ConfigService, private readonly jwt: JwtService) {}

  newRefreshToken(): NewRefreshToken {
    const jti = randomUUID();
    const secret = randomUUID();
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
    return this.jwt.signAsync({ sub: userId }, { algorithm: 'HS256', expiresIn: Math.floor(this.config.jwt.accessTtlMs / 1_000) });
  }
}
