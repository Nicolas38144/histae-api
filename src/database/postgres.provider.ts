import { Provider } from '@nestjs/common';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';

export const postgresProvider: Provider = {
  provide: 'POSTGRES',
  useFactory: async (config: ConfigService) => {
    const db = config.get('app.postgres');
    const pool = new Pool({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
      max: 20,
    });

    try {
      const client = await pool.connect();
      console.log('✅ Connected to PostgreSQL');
      client.release();
    } catch (err) {
      console.error('❌ Failed to connect to PostgreSQL', err);
    }

    return pool;
  },
  inject: [ConfigService],
};
