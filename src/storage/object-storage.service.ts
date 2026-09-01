import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '../config/config.service';

const OBJECT_STORAGE_REQUEST_TIMEOUT_MILLIS = 10_000;

export type StoredObject = {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
};

export class ObjectStorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Object storage is unavailable.', { cause });
    this.name = 'ObjectStorageUnavailableError';
  }
}

@Injectable()
export class ObjectStorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.objectStorage.bucket;
    this.client = new S3Client({
      endpoint: config.objectStorage.endpoint,
      region: config.objectStorage.region,
      forcePathStyle: config.objectStorage.forcePathStyle,
      credentials: {
        accessKeyId: config.objectStorage.accessKey,
        secretAccessKey: config.objectStorage.secretKey,
      },
      maxAttempts: 3,
    });
  }

  async put(object: StoredObject): Promise<void> {
    await this.execute(this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: object.key,
      Body: object.body,
      ContentLength: object.body.length,
      ContentType: object.contentType,
      CacheControl: object.cacheControl,
    }), requestOptions()));
  }

  async delete(key: string): Promise<void> {
    await this.execute(this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      requestOptions(),
    ));
  }

  async signedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
    return this.execute(getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    ));
  }

  async check(): Promise<void> {
    await this.execute(this.client.send(
      new HeadBucketCommand({ Bucket: this.bucket }),
      requestOptions(),
    ));
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private async execute<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      throw new ObjectStorageUnavailableError(error);
    }
  }
}

function requestOptions(): { abortSignal: AbortSignal } {
  return { abortSignal: AbortSignal.timeout(OBJECT_STORAGE_REQUEST_TIMEOUT_MILLIS) };
}
