import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  const config = app.get(ConfigService);

  const port = config.get<number>('app.port')!;
  const host = config.get<string>('app.host')!;
  const prefix = config.get<string>('app.prefix')!;

  app.setGlobalPrefix(prefix);
  app.enableCors();

  await app.listen(port, host);
  console.log(`🚀 Server running on http://${host}:${port}/${prefix}`);
}
bootstrap();
