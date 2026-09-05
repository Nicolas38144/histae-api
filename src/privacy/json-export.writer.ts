import type { FileHandle } from 'node:fs/promises';

type JsonContext = { kind: 'array' | 'object'; first: boolean };

export class DataExportTooLargeError extends Error {
  constructor() {
    super('The generated data export exceeds its configured byte limit.');
    this.name = 'DataExportTooLargeError';
  }
}

export class JsonExportWriter {
  private readonly contexts: JsonContext[] = [];
  private writtenBytes = 0;

  constructor(
    private readonly file: FileHandle,
    private readonly maxBytes: number,
  ) {}

  get bytes(): number {
    return this.writtenBytes;
  }

  async startObject(name?: string): Promise<void> {
    await this.beforeValue(name);
    await this.write('{');
    this.contexts.push({ kind: 'object', first: true });
  }

  async endObject(): Promise<void> {
    this.closeContext('object');
    await this.write('}');
  }

  async startArray(name: string): Promise<void> {
    await this.beforeValue(name);
    await this.write('[');
    this.contexts.push({ kind: 'array', first: true });
  }

  async endArray(): Promise<void> {
    this.closeContext('array');
    await this.write(']');
  }

  async property(name: string, value: unknown): Promise<void> {
    await this.beforeValue(name);
    await this.write(JSON.stringify(value));
  }

  async item(value: unknown): Promise<void> {
    await this.beforeValue();
    await this.write(JSON.stringify(value));
  }

  assertComplete(): void {
    if (this.contexts.length !== 0) throw new Error('data export JSON document is incomplete');
  }

  private async beforeValue(name?: string): Promise<void> {
    const context = this.contexts.at(-1);
    if (!context) {
      if (this.writtenBytes !== 0 || name !== undefined) throw new Error('invalid data export JSON root');
      return;
    }
    if (context.kind === 'object' && name === undefined) throw new Error('object property name is required');
    if (context.kind === 'array' && name !== undefined) throw new Error('array items cannot be named');
    if (!context.first) await this.write(',');
    context.first = false;
    if (name !== undefined) await this.write(`${JSON.stringify(name)}:`);
  }

  private closeContext(expected: JsonContext['kind']): void {
    const context = this.contexts.pop();
    if (context?.kind !== expected) throw new Error('invalid data export JSON nesting');
  }

  private async write(value: string | undefined): Promise<void> {
    if (value === undefined) throw new Error('unsupported undefined value in data export');
    const buffer = Buffer.from(value, 'utf8');
    if (this.writtenBytes + buffer.byteLength > this.maxBytes) throw new DataExportTooLargeError();
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesWritten } = await this.file.write(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesWritten === 0) throw new Error('data export write made no progress');
      offset += bytesWritten;
    }
    this.writtenBytes += buffer.byteLength;
  }
}
