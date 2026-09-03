import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import type { NewRefreshToken } from './auth.models';

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
    if (parts.length !== 2 || !isUUID(parts[0], '4') || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return undefined;
    return { jti: parts[0], hash: createHash('sha256').update(parts[1]).digest('hex') };
  }

  accessToken(userId: string, sessionId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, sid: sessionId, typ: ACCESS_TOKEN_TYPE },
      {
        algorithm: 'HS256',
        keyid: this.config.jwt.activeKid,
        secret: this.config.jwt.secret,
        audience: ACCESS_TOKEN_AUDIENCE,
        issuer: ACCESS_TOKEN_ISSUER,
        expiresIn: Math.floor(this.config.jwt.accessTtlMs / 1_000),
      },
    );
  }
}
