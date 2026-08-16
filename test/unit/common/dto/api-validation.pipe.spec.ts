import type { ArgumentMetadata } from '@nestjs/common';
import { SendOtpDto } from '../../../../src/auth/dto/auth.dto';
import { ApiValidationPipe } from '../../../../src/common/dto/api-validation.pipe';

const otpBodyMetadata: ArgumentMetadata = { type: 'body', metatype: SendOtpDto, data: undefined };

describe('ApiValidationPipe', () => {
  it('transforms a valid payload into its DTO', async () => {
    const dto = await new ApiValidationPipe().transform({ phone_number: '+33612345678' }, otpBodyMetadata) as SendOtpDto;

    expect(dto).toBeInstanceOf(SendOtpDto);
    expect(dto.phone_number).toBe('+33612345678');
  });

  it('rejects unknown or missing fields with the API error envelope', async () => {
    const pipe = new ApiValidationPipe('invalid_request_body', 'The request body is invalid.');

    await expect(pipe.transform({ phone_number: '+33612345678', ignored: true }, otpBodyMetadata))
      .rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_request_body' }));
    await expect(pipe.transform({}, otpBodyMetadata))
      .rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_request_body' }));
  });
});
