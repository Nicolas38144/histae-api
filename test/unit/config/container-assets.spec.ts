import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('container deployment assets', () => {
  it('builds a non-root production image without copying the source tree or secrets', () => {
    const dockerfile = fixture('Dockerfile');
    const productionStage = dockerfile.split('FROM base AS production')[1];

    expect(productionStage).toBeDefined();
    expect(productionStage).toContain('COPY --from=build --chown=node:node /app/container-dist ./container-dist');
    expect(productionStage).toContain('USER node');
    expect(productionStage).not.toContain('COPY . .');

    const dockerignore = fixture('.dockerignore');
    for (const privatePath of ['.env', '.env.*', '.secrets']) expect(dockerignore).toContain(privatePath);
  });

  it('keeps the base runtime private and hardens the application processes', () => {
    const compose = fixture('compose.yaml');

    expect(compose).not.toContain('ports:');
    expect(compose).toContain('user: "1000:1000"');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('condition: service_completed_successfully');
  });

  it('publishes development dependencies only on loopback and separates production networks', () => {
    const development = fixture('compose.dev.yaml');
    const production = fixture('compose.production.yaml');

    for (const port of ['5432', '6379', '8333', '8090', '8080']) {
      expect(development).toMatch(new RegExp(`127\\.0\\.0\\.1:[^\\n]*${port}`));
    }
    expect(development).toContain('storage.histae.localhost');
    expect(production).not.toContain('ports:');
    expect(production).toContain('external: true');
    expect(production).toContain('- edge');
  });

  it('replaces the legacy per-service compositions with one canonical development stack', () => {
    for (const legacy of [
      'docker-compose-redis.yaml',
      'docker-compose.object-storage.yml',
      'docker-compose.photo-moderation.yml',
    ]) expect(existsSync(resolve(process.cwd(), legacy))).toBe(false);
  });

  it('caps production PostgreSQL at 7 GiB without swap and keeps development lightweight and isolated', () => {
    const developmentPostgres = fixture('compose.dev.yaml').split('  postgres:')[1].split(/^ {2}[a-z][\w-]*:/m)[0];
    expect(developmentPostgres).toMatch(/mem_limit: 1g/);
    const production = fixture('compose.production.yaml');
    const postgres = production.split('  postgres:')[1].split(/^ {2}[a-z][\w-]*:/m)[0];
    expect(postgres).toMatch(/mem_limit: 7g/);
    expect(postgres).toMatch(/memswap_limit: 7g/);
    expect(production).toContain('name: histae-api-production');
    expect(production).toContain('histae-postgres-production-data:/var/lib/postgresql');
    expect(production).not.toContain('histae-postgres-data:/var/lib/postgresql');
  });

  it('requires authenticated TLS for production PostgreSQL and distributes only its public CA to clients', () => {
    const production = fixture('compose.production.yaml');
    expect(production).toContain('POSTGRES_SSLMODE: verify-full');
    expect(production).toContain('NODE_EXTRA_CA_CERTS: /run/secrets/postgres_ca');
    for (const service of ['migrate', 'api', 'outbox-worker', 'maintenance']) {
      const block = production.split('services:')[1].split(`  ${service}:`)[1].split(/^(?: {2}[a-z][\w-]*:|[a-z])/m)[0];
      expect(block).toContain('<<: *production-database-environment');
      expect(block).toContain('- postgres_ca');
      expect(block).not.toContain('server.key');
    }
    const config = fixture('docker/postgres/postgresql.conf');
    expect(config).toMatch(/^ssl = on$/m);
    expect(config).toContain("hba_file = '/etc/postgresql/histae/pg_hba.conf'");
    const hba = fixture('docker/postgres/pg_hba.conf');
    expect(hba).toMatch(/^hostnossl all all all reject$/m);
    expect(hba).toMatch(/^hostssl all all all scram-sha-256$/m);
    expect(hba).not.toMatch(/^host.*trust/m);
  });

  it('colocates Redis, S3 and moderation while isolating raw storage behind HTTPS', () => {
    const production = fixture('compose.production.yaml');
    for (const service of ['redis', 'object-storage', 'storage-gateway', 'storage-init', 'photo-moderation']) {
      expect(production).toContain(`  ${service}:`);
    }
    const storage = production.split('  object-storage:')[1].split(/^ {2}[a-z][\w-]*:/m)[0];
    expect(storage).toContain('networks: [storage]');
    expect(storage).toContain('- -s3.config=/run/secrets/s3_identity');
    expect(storage).not.toContain('mini');
    const redis = fixture('docker/redis/redis.conf');
    expect(redis).toMatch(/^port 0$/m);
    expect(redis).toMatch(/^tls-port 6379$/m);
    expect(fixture('docker/storage-gateway/nginx.conf')).toContain('proxy_set_header Host $http_host;');
  });
});

function fixture(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}
