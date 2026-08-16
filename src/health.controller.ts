import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseService } from './database/database.service';
import { HealthResponseDto } from './common/dto/responses.dto';
import { ScyllaService } from './scylla/scylla.service';
import { RedisService } from './redis/redis.service';

@Controller('health')
@ApiTags('Health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly scylla: ScyllaService,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  @ApiOkResponse({ type: HealthResponseDto })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({ description: 'PostgreSQL, enabled ScyllaDB, or required Redis is unavailable.' })
  async ready(): Promise<{ status: 'ready' }> {
    try {
      await this.database.query('SELECT 1');
      await this.scylla.check();
      await this.redis.check();
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('A required dependency is unavailable.');
    }
  }
}
