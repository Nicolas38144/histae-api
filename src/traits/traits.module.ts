import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TraitsController } from './traits.controller';
import { TraitsRepository } from './traits.repository';
import { TraitsService } from './traits.service';

@Module({ imports: [AuthModule], controllers: [TraitsController], providers: [TraitsRepository, TraitsService] })
export class TraitsModule {}
