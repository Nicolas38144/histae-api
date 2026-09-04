import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module';
import { ErasureRepository } from './erasure.repository';
import { ErasureService } from './erasure.service';

@Global()
@Module({ imports: [DiscoveryModule], providers: [ErasureRepository, ErasureService], exports: [ErasureService] })
export class ErasureModule {}
