import { Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ValidatedBody, ValidatedParams } from '../common/http/validated-request.decorator';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AdminGuard, JwtActiveGuard, userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { TraitsService } from './traits.service';
import { CreateTraitDto, TraitIdDto, TraitIdParamDto } from './dto/traits.dto';
import type { Trait } from './traits.repository';
import { TraitListResponseDto, TraitResponseDto } from './dto/traits.responses';
import { MessageResponseDto } from '../common/dto/responses.dto';

@Controller('api')
@ApiTags('Traits')
@ApiBearerAuth()
export class TraitsController {
  constructor(private readonly traits: TraitsService) {}

  @Get('traits')
  @UseGuards(JwtActiveGuard)
  @ApiOkResponse({ type: TraitListResponseDto })
  async list(): Promise<{ traits: Trait[] }> {
    return { traits: await this.traits.list() };
  }

  @Post('users/me/traits')
  @UseGuards(JwtActiveGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async add(
    @ValidatedBody({ code: 'invalid_user_trait_payload', message: 'The user trait request body is invalid.' }) body: TraitIdDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.traits.addToUser(userId(request), body.traitId);
  }

  @Delete('users/me/traits/:traitId')
  @UseGuards(JwtActiveGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(
    @ValidatedParams({ code: 'invalid_trait_id', message: 'The trait ID must be a valid UUID.' }) params: TraitIdDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.traits.removeFromUser(userId(request), params.traitId);
  }

  @Post('admin/traits')
  @UseGuards(JwtActiveGuard, AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: TraitResponseDto })
  async create(@ValidatedBody({ code: 'invalid_trait_payload', message: 'The trait request body is invalid.' }) body: CreateTraitDto): Promise<Trait> {
    return this.traits.create(body.name);
  }

  @Patch('admin/traits/:id')
  @UseGuards(JwtActiveGuard, AdminGuard)
  @ApiOkResponse({ type: MessageResponseDto })
  async update(
    @ValidatedParams({ code: 'invalid_trait_id', message: 'The trait ID must be a valid UUID.' }) params: TraitIdParamDto,
    @ValidatedBody({ code: 'invalid_trait_payload', message: 'The trait request body is invalid.' }) body: CreateTraitDto,
  ): Promise<{ message: string }> {
    await this.traits.update(params.id, body.name);
    return { message: 'trait updated' };
  }

  @Delete('admin/traits/:id')
  @UseGuards(JwtActiveGuard, AdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async delete(@ValidatedParams({ code: 'invalid_trait_id', message: 'The trait ID must be a valid UUID.' }) params: TraitIdParamDto): Promise<void> {
    await this.traits.delete(params.id);
  }
}
