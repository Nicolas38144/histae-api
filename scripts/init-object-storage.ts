import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '../src/config/config.service';
import { writeCliFailure } from './cli-output';

export async function ensureBucket(client: Pick<S3Client, 'send'>, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (error) {
    if (!(error instanceof Error) || !['NotFound', 'NoSuchBucket'].includes(error.name)) throw error;
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'BucketAlreadyOwnedByYou') throw error;
  }
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

async function run(): Promise<void> {
  const config = new ConfigService().objectStorage;
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    maxAttempts: 3,
    requestHandler: { requestTimeout: 10_000 },
  });
  try { await ensureBucket(client, config.bucket); } finally { client.destroy(); }
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    writeCliFailure('object_storage_init_failed', error);
    process.exitCode = 1;
  });
}
