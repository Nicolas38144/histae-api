import { readFileSync } from 'node:fs';
import { auth, Client, types } from 'cassandra-driver';
import type { ClientOptions } from 'cassandra-driver';
import type { ScyllaConfig } from '../config/config.service';

export function createScyllaClient(config: ScyllaConfig, useKeyspace = true): Client {
  const options: ClientOptions = {
    contactPoints: config.contactPoints,
    localDataCenter: config.localDataCenter,
    protocolOptions: { port: config.port },
    socketOptions: {
      connectTimeout: config.connectTimeoutMillis,
      readTimeout: config.requestTimeoutMillis,
      keepAlive: true,
    },
    queryOptions: {
      consistency: types.consistencies.localQuorum,
      serialConsistency: types.consistencies.localSerial,
      prepare: true,
    },
  };
  if (useKeyspace) options.keyspace = config.keyspace;
  if (config.username) options.authProvider = new auth.PlainTextAuthProvider(config.username, config.password);
  if (config.tls) {
    options.sslOptions = {
      rejectUnauthorized: true,
      ...(config.tlsCaPath ? { ca: [readFileSync(config.tlsCaPath)] } : {}),
    };
  }
  return new Client(options);
}
