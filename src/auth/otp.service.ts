import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import { hmacSha256 } from '../crypto/phone-crypto';
import { AuthRepository } from './auth.repository';

@Injectable()
export class OtpService {
  constructor(private readonly config: ConfigService, private readonly authRepository: AuthRepository) {}

  validatePhoneForDelivery(phoneInput: string): void {
    this.normalizePhone(phoneInput, 'invalid_phone_number', 'The phone number must use the international E.164 format.');
  }

  normalizePhone(phoneInput: string, code: string, message: string): string {
    return normalizePhone(phoneInput, code, message);
  }

  rateLimitKey(phoneInput: string, code: string, message: string): string {
    return hmacSha256(this.normalizePhone(phoneInput, code, message), this.config.phone.hashKey);
  }

  async consume(phoneInput: string, otp: string): Promise<{ phone: string; phoneHash: string }> {
    const phone = this.normalizePhone(phoneInput, 'invalid_otp_request', 'The phone number or verification code is invalid.');
    if (!/^[0-9]{6}$/.test(otp)) throw apiError(400, 'invalid_otp_request', 'The phone number or verification code is invalid.');
    const phoneHash = hmacSha256(phone, this.config.phone.hashKey);
    const otpHash = hmacSha256(otp, this.config.phone.hashKey);
    if (!await this.authRepository.consumeOtp(phoneHash, otpHash)) {
      throw apiError(401, 'invalid_or_expired_otp', 'The verification code is invalid or expired.');
    }
    return { phone, phoneHash };
  }
}

function normalizePhone(input: string, code: string, message: string): string {
  const phone = input.trim().replace(/[ .()-]/g, '');
  if (phone.length < 9 || phone.length > 16 || !phone.startsWith('+') || !/^\+[0-9]+$/.test(phone) || phone[1] === '0') {
    throw apiError(400, code, message);
  }
  return phone;
}
