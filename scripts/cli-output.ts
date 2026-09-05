import { formatErrorEvent } from '../src/common/logging/safe-logging';

export function writeCliFailure(event: string, error: unknown): void {
  process.stderr.write(`${formatErrorEvent(event, error)}\n`);
}
