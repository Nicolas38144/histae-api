import { Module, Global } from '@nestjs/common';
import { postgresProvider } from './postgres.provider';
import { scyllaProvider } from './scylla.provider';
// import { redisProvider } from './redis.provider';

@Global()
@Module({
  providers: [postgresProvider, scyllaProvider/*, redisProvider*/],
  exports: [postgresProvider, scyllaProvider/*, redisProvider*/],
})
export class DatabaseModule {}
