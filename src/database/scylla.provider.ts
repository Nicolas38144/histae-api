import { Provider } from '@nestjs/common';
import { Client } from 'cassandra-driver';
import { ConfigService } from '@nestjs/config';

export const scyllaProvider: Provider = {
  provide: 'SCYLLA',
  useFactory: async (config: ConfigService) => {
    const scylla = config.get('app.scylla');
    const client = new Client({
      contactPoints: [scylla.host],
      localDataCenter: 'datacenter1',
      keyspace: scylla.keyspace,
    });

    try {
      await client.connect();
      console.log('✅ Connected to ScyllaDB');
    } catch (err) {
      console.error('❌ Failed to connect to ScyllaDB', err);
    }

    return client;
  },
  inject: [ConfigService],
};
