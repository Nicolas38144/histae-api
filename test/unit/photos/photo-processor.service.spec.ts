import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  InvalidPhotoError,
  MAX_STORED_PHOTO_BYTES,
  PhotoProcessorService,
  PhotoTooLargeError,
} from '../../../src/photos/photo-processor.service';

const FIXTURES = join(process.cwd(), 'test', 'fixtures', 'photos');

describe('PhotoProcessorService', () => {
  const processor = new PhotoProcessorService();

  it.each([
    ['sample.jpg', 'image/jpeg'],
    ['sample.jpeg', 'image/jpeg'],
    ['sample.png', 'image/png'],
    ['sample.heic', 'image/heic'],
    ['sample.heif', 'image/heif'],
    ['sample.webp', 'image/webp'],
  ])('accepts %s and stores a WebP no larger than 500,000 bytes', async (filename, mimetype) => {
    const result = await processor.toWebp({
      filename,
      mimetype,
      body: await readFile(join(FIXTURES, filename)),
    });
    const metadata = await sharp(result).metadata();

    expect(result.length).toBeLessThanOrEqual(MAX_STORED_PHOTO_BYTES);
    expect(metadata).toEqual(expect.objectContaining({ format: 'webp' }));
    expect(metadata.width).toBeLessThanOrEqual(2_048);
    expect(metadata.height).toBeLessThanOrEqual(2_048);
  }, 30_000);

  it('rejects unsupported extensions', async () => {
    await expect(processor.toWebp({
      filename: 'portrait.gif',
      mimetype: 'image/gif',
      body: Buffer.from('GIF89a'),
    })).rejects.toBeInstanceOf(InvalidPhotoError);
  });

  it('rejects a file whose contents do not match its extension', async () => {
    await expect(processor.toWebp({
      filename: 'portrait.jpg',
      mimetype: 'image/jpeg',
      body: await readFile(join(FIXTURES, 'sample.png')),
    })).rejects.toBeInstanceOf(InvalidPhotoError);
  });

  it('rejects an upload larger than exactly 500,000 bytes before decoding it', async () => {
    await expect(processor.toWebp({
      filename: 'portrait.jpg',
      mimetype: 'image/jpeg',
      body: Buffer.alloc(500_001),
    })).rejects.toBeInstanceOf(PhotoTooLargeError);
  });
});
