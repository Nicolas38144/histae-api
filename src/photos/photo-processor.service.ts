import { Injectable } from '@nestjs/common';
import { extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import sharp, { type Sharp } from 'sharp';

export const ACCEPTED_PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'] as const;
export const MAX_PHOTO_UPLOAD_BYTES = 500_000;
export const MAX_STORED_PHOTO_BYTES = 500_000;
export const MAX_PHOTO_PIXELS = 40_000_000;
export const MAX_PHOTO_EDGE = 2_048;

type PhotoFormat = 'jpeg' | 'png' | 'heif' | 'webp';

const FORMAT_BY_EXTENSION: Record<(typeof ACCEPTED_PHOTO_EXTENSIONS)[number], PhotoFormat> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.heic': 'heif',
  '.heif': 'heif',
  '.webp': 'webp',
};

const MIME_TYPES: Record<PhotoFormat, ReadonlySet<string>> = {
  jpeg: new Set(['image/jpeg', 'image/jpg', 'application/octet-stream']),
  png: new Set(['image/png', 'application/octet-stream']),
  heif: new Set(['image/heic', 'image/heif', 'application/octet-stream']),
  webp: new Set(['image/webp', 'application/octet-stream']),
};

export class InvalidPhotoError extends Error {
  constructor(message = 'The uploaded photo is invalid.') {
    super(message);
    this.name = 'InvalidPhotoError';
  }
}

export class PhotoTooLargeError extends Error {
  constructor() {
    super('The uploaded photo is too large.');
    this.name = 'PhotoTooLargeError';
  }
}

export type UploadedPhoto = { filename: string; mimetype: string; body: Buffer };

@Injectable()
export class PhotoProcessorService {
  async toWebp(upload: UploadedPhoto): Promise<Buffer> {
    if (!upload.body.length) throw new InvalidPhotoError();
    if (upload.body.length > MAX_PHOTO_UPLOAD_BYTES) throw new PhotoTooLargeError();

    const extension = extname(upload.filename).toLowerCase();
    if (!isAcceptedExtension(extension)) throw new InvalidPhotoError('The photo file extension is not supported.');
    const expectedFormat = FORMAT_BY_EXTENSION[extension];
    const declaredMime = upload.mimetype.toLowerCase();
    if (!MIME_TYPES[expectedFormat].has(declaredMime)) throw new InvalidPhotoError('The photo media type does not match its extension.');

    const detectedFormat = detectFormat(upload.body);
    if (detectedFormat !== expectedFormat) throw new InvalidPhotoError('The photo contents do not match its extension.');

    try {
      return expectedFormat === 'heif'
        ? await convertHeif(upload.body)
        : await convertSharp(upload.body, expectedFormat);
    } catch (error) {
      if (error instanceof InvalidPhotoError || error instanceof PhotoTooLargeError) throw error;
      throw new InvalidPhotoError('The photo could not be decoded.');
    }
  }
}

async function convertSharp(input: Buffer, expectedFormat: PhotoFormat): Promise<Buffer> {
  const image = sharp(input, { failOn: 'error', limitInputPixels: MAX_PHOTO_PIXELS, animated: false, sequentialRead: true });
  const metadata = await image.metadata();
  if (metadata.format !== expectedFormat || !metadata.width || !metadata.height
    || metadata.width * metadata.height > MAX_PHOTO_PIXELS || (metadata.pages ?? 1) !== 1) {
    throw new InvalidPhotoError();
  }
  return encodeWebp(image.rotate());
}

async function convertHeif(input: Buffer): Promise<Buffer> {
  const metadata = await sharp(input, { failOn: 'error', limitInputPixels: false, animated: false }).metadata();
  if (metadata.format !== 'heif' || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
    throw new InvalidPhotoError();
  }
  if (metadata.width * metadata.height > MAX_PHOTO_PIXELS) throw new PhotoTooLargeError();
  const decoded = await decodeHeifInWorker(input);
  if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_PHOTO_PIXELS
    || decoded.data.byteLength !== decoded.width * decoded.height * 4) {
    throw new InvalidPhotoError();
  }
  return encodeWebp(sharp(Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength), {
    raw: { width: decoded.width, height: decoded.height, channels: 4 },
    limitInputPixels: MAX_PHOTO_PIXELS,
  }));
}

type DecodedHeif = { width: number; height: number; data: Uint8Array };

function decodeHeifInWorker(input: Buffer): Promise<DecodedHeif> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(HEIF_DECODER_WORKER, { eval: true, workerData: input });
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      result();
      void worker.terminate();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('HEIF decoding timed out.')));
    }, 30_000);
    worker.once('message', (message: unknown) => {
      if (!isDecodedHeif(message)) {
        finish(() => reject(new Error('HEIF decoding failed.')));
        return;
      }
      finish(() => resolve(message));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error('HEIF decoder stopped unexpectedly.')));
    });
  });
}

function isDecodedHeif(value: unknown): value is DecodedHeif {
  return typeof value === 'object' && value !== null
    && 'width' in value && typeof value.width === 'number'
    && 'height' in value && typeof value.height === 'number'
    && 'data' in value && value.data instanceof Uint8Array;
}

const HEIF_DECODER_WORKER = `
  const { parentPort, workerData } = require('node:worker_threads');
  const decode = require('heic-decode');
  Promise.resolve(decode({ buffer: Buffer.from(workerData) }))
    .then(({ width, height, data }) => {
      const pixels = Uint8Array.from(data);
      parentPort.postMessage({ width, height, data: pixels }, [pixels.buffer]);
    })
    .catch(() => parentPort.postMessage({ error: true }));
`;

async function encodeWebp(image: Sharp): Promise<Buffer> {
  const attempts = [
    { edge: MAX_PHOTO_EDGE, quality: 82 },
    { edge: 1_800, quality: 74 },
    { edge: 1_600, quality: 68 },
    { edge: 1_400, quality: 62 },
    { edge: 1_200, quality: 56 },
    { edge: 1_024, quality: 50 },
  ];
  for (const attempt of attempts) {
    const result = await image.clone()
      .resize({ width: attempt.edge, height: attempt.edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: attempt.quality, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    if (result.info.format !== 'webp') throw new InvalidPhotoError();
    if (result.data.length <= MAX_STORED_PHOTO_BYTES) return result.data;
  }
  throw new PhotoTooLargeError();
}

function detectFormat(buffer: Buffer): PhotoFormat | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (isHeif(buffer)) return 'heif';
  return undefined;
}

function isHeif(buffer: Buffer): boolean {
  if (buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const boxSize = buffer.readUInt32BE(0);
  if (boxSize < 16 || boxSize > buffer.length) return false;
  const brands = new Set<string>();
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) brands.add(buffer.toString('ascii', offset, offset + 4));
  return [...brands].some((brand) => HEIF_BRANDS.has(brand));
}

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',
]);

function isAcceptedExtension(value: string): value is (typeof ACCEPTED_PHOTO_EXTENSIONS)[number] {
  return (ACCEPTED_PHOTO_EXTENSIONS as readonly string[]).includes(value);
}
