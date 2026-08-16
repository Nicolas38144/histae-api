import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({ imports: [AuthModule, DiscoveryModule], controllers: [UsersController], providers: [UsersRepository, UsersService], exports: [UsersService] })
export class UsersModule {}
