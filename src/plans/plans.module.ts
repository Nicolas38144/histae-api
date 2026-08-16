import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansRepository } from './plans.repository';
import { PlansService } from './plans.service';

@Module({ controllers: [PlansController], providers: [PlansRepository, PlansService] })
export class PlansModule {}
