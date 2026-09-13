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
});

function fixture(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}
