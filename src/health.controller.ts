import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { ScyllaService } from './scylla/scylla.service';
import { RedisService } from './redis/redis.service';
import { ObjectStorageService } from './storage/object-storage.service';

@Controller('health')

export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly scylla: ScyllaService,
    private readonly redis: RedisService,
    private readonly objectStorage: ObjectStorageService,
  ) {}

  @Get('live')

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')

  async ready(): Promise<{ status: 'ready' }> {
    try {
      await this.database.query('SELECT 1');
      await this.scylla.check();
      await this.redis.check();
      await this.objectStorage.check();
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('A required dependency is unavailable.');
    }
  }
}
