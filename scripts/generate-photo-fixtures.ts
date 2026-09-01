import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const FIXTURE_DIRECTORY = join(process.cwd(), 'test', 'fixtures', 'photos');

async function main(): Promise<void> {
  await mkdir(FIXTURE_DIRECTORY, { recursive: true });

  const source = Buffer.from(`
    <svg width="960" height="720" viewBox="0 0 960 720" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#4169e1"/>
          <stop offset="1" stop-color="#f29f67"/>
        </linearGradient>
      </defs>
      <rect width="960" height="720" fill="url(#sky)"/>
      <circle cx="740" cy="150" r="75" fill="#ffe48d"/>
      <path d="M0 610 L260 330 L440 540 L640 300 L960 620 V720 H0 Z" fill="#203864"/>
      <path d="M0 650 L330 440 L520 620 L760 430 L960 590 V720 H0 Z" fill="#315b47"/>
      <text x="48" y="92" font-family="sans-serif" font-size="44" fill="#ffffff">Histae photo fixture</text>
    </svg>
  `);

  await Promise.all([
    sharp(source).jpeg({ quality: 90 }).toFile(join(FIXTURE_DIRECTORY, 'sample.jpg')),
    sharp(source).jpeg({ quality: 82 }).toFile(join(FIXTURE_DIRECTORY, 'sample.jpeg')),
    sharp(source).png({ compressionLevel: 9 }).toFile(join(FIXTURE_DIRECTORY, 'sample.png')),
    sharp(source).webp({ quality: 82 }).toFile(join(FIXTURE_DIRECTORY, 'sample.webp')),
  ]);
  await copyFile(join(FIXTURE_DIRECTORY, 'sample.heic'), join(FIXTURE_DIRECTORY, 'sample.heif'));
}

void main();
