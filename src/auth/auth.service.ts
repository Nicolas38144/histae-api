import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    @Inject('POSTGRES') private readonly pg: Pool,
  ) {}

  async register(dto: RegisterDto) {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');

      const passwordHash = await bcrypt.hash(dto.password, 10);

      const accountResult = await client.query(
        `INSERT INTO user_account (email, phone_number_hash, password_hash)
         VALUES ($1, $2, $3) RETURNING id`,
        [dto.email, this.hashPhone(dto.phone_number), passwordHash],
      );
      const userId = accountResult.rows[0].id;

      await client.query(
        `INSERT INTO user_profile (user_id, firstname, birthdate, sex, bio)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, dto.firstname, dto.birthdate, dto.sex, dto.bio || null],
      );

      await client.query('COMMIT');

      return this.createTokens(userId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async login(dto: LoginDto) {
    const client = await this.pg.connect();
    try {
      const res = await client.query(
        `SELECT * FROM user_account WHERE email=$1 OR phone_number_hash=$2`,
        [dto.email, dto.phone_number ? this.hashPhone(dto.phone_number) : null],
      );
      const user = res.rows[0];
      if (!user) throw new UnauthorizedException();

      const valid = await bcrypt.compare(dto.password, user.password_hash);
      if (!valid) throw new UnauthorizedException();

      return this.createTokens(user.id);
    } finally {
      client.release();
    }
  }

  async refresh(refreshToken: string) {
    const client = await this.pg.connect();
    try {
      const res = await client.query(
        `SELECT * FROM refresh_token WHERE token=$1 AND expires_at > NOW()`,
        [refreshToken],
      );
      const tokenRow = res.rows[0];
      if (!tokenRow) throw new UnauthorizedException('Invalid refresh token');

      const access_token = this.jwtService.sign({ sub: tokenRow.user_id });
      return { access_token };
    } finally {
      client.release();
    }
  }

  private createTokens(userId: string) {
    const access_token = this.jwtService.sign({ sub: userId });
    const refresh_token = uuidv4();
    const expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    this.pg.query(
      `INSERT INTO refresh_token (id, user_id, token, expires_at) VALUES ($1,$2,$3,$4)`,
      [uuidv4(), userId, refresh_token, expires_at],
    );

    return { access_token, refresh_token };
  }

  private hashPhone(phone: string) {
    return crypto.createHash('sha256').update(phone).digest('hex');
  }
}
