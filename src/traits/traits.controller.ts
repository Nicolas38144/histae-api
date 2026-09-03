import { Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ValidatedBody, ValidatedParams } from '../common/http/validated-request.decorator';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import { AdminSessionGuard } from '../admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { TraitsService } from './traits.service';
import { CreateTraitDto, TraitIdDto, TraitIdParamDto } from './dto/traits.dto';
import type { Trait } from './traits.repository';

@Controller('api')

export class TraitsController {
  constructor(private readonly traits: TraitsService) {}

  @Get('traits')
  @UseGuards(JwtActiveGuard)

  async list(): Promise<{ traits: Trait[] }> {
    return { traits: await this.traits.list() };
  }

  @Get('users/me/traits')
  @UseGuards(JwtActiveGuard)

  async listMine(@Req() request: AuthenticatedRequest): Promise<{ traits: Trait[] }> {
    return { traits: await this.traits.listForUser(userId(request)) };
  }

  @Post('users/me/traits')
  @UseGuards(JwtActiveGuard)
  @HttpCode(HttpStatus.NO_CONTENT)

  async add(
    @ValidatedBody({ code: 'invalid_user_trait_payload', message: 'The user trait request body is invalid.' }) body: TraitIdDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.traits.addToUser(userId(request), body.traitId);
  }

  @Delete('users/me/traits/:traitId')
  @UseGuards(JwtActiveGuard)
  @HttpCode(HttpStatus.NO_CONTENT)

  async remove(
    @ValidatedParams({ code: 'invalid_trait_id', message: 'The trait ID must be a valid UUID.' }) params: TraitIdDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.traits.removeFromUser(userId(request), params.traitId);
  }

  @Post('admin/traits')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.CREATED)

  async create(@ValidatedBody({ code: 'invalid_trait_payload', message: 'The trait request body is invalid.' }) body: CreateTraitDto): Promise<Trait> {
    return this.traits.create(body.name);
  }

  @Patch('admin/traits/:id')
  @UseGuards(AdminSessionGuard)

  async update(
    @ValidatedParams({ code: 'invalid_trait_id', message: 'The trait ID must be a valid UUID.' }) params: TraitIdParamDto,
    @ValidatedBody({ code: 'invalid_trait_payload', message: 'The trait request body is invalid.' }) body: CreateTraitDto,
  ): Promise<{ message: string }> {
    await this.traits.update(params.id, body.name);
    return { message: 'trait updated' };
  }

  @Delete('admin/traits/:id')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)

  async delete(@ValidatedParams({ code: 'invalid_trait_id', message: 'The trait ID must be a valid UUID.' }) params: TraitIdParamDto): Promise<void> {
    await this.traits.delete(params.id);
  }
}
