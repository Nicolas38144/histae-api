// Exécuté uniquement par production-services-smoke.sh sur son réseau isolé.
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { createClient } from 'redis';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ensureBucket } from '/app/container-dist/scripts/init-object-storage.js';

async function checkRedis(password, tls) {
  const redis = createClient({ url: `${tls ? 'rediss' : 'redis'}://redis:6379`, password,
    socket: { reconnectStrategy: false, connectTimeout: 2000 } });
  redis.on('error', () => {});
  try { await redis.connect(); assert.equal(await redis.ping(), 'PONG'); }
  finally { if (redis.isOpen) await redis.disconnect(); }
}

let stage = 'redis_tls';
async function run() {
  await checkRedis('smoke-password', true);
  stage = 'redis_bad_password';
  await assert.rejects(checkRedis('incorrect', true));
  stage = 'redis_plaintext';
  await assert.rejects(checkRedis('smoke-password', false));
  const s3 = new S3Client({ endpoint: 'https://storage-smoke.test', region: 'us-east-1',
    forcePathStyle: true, credentials: { accessKeyId: 'smoke-access', secretAccessKey: 'smoke-secret' },
    maxAttempts: 3, requestHandler: { requestTimeout: 5000 } });
  try {
    stage = 's3_init';
    await ensureBucket(s3, 'smoke-photos');
    await ensureBucket(s3, 'smoke-photos');
    stage = 's3_put';
    await s3.send(new PutObjectCommand({ Bucket: 'smoke-photos', Key: 'test.webp', Body: 'smoke' }));
    const publicUrl = 'https://storage-smoke.test/smoke-photos/test.webp';
    stage = 's3_anonymous';
    const denied = await globalThis.fetch(publicUrl);
    assert.equal(denied.status, 403);
    stage = 's3_signed_url';
    const signed = await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'smoke-photos', Key: 'test.webp' }), { expiresIn: 60 });
    const response = await globalThis.fetch(signed);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'smoke');
  } finally { s3.destroy(); }
  console.log('PASS: Redis TLS/auth, S3 bucket initialization, private object and signed HTTPS URL.');
}
run().catch((error) => {
  const code = /^[a-zA-Z0-9_]+$/.test(error.name) ? error.name : 'unknown';
  console.error(`production_services_smoke_failed stage=${stage} code=${code}`);
  process.exitCode = 1;
});
