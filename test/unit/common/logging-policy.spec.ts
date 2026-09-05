import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOTS = ['src', 'scripts'];
const LOGGER_METHODS = new Set(['debug', 'error', 'log', 'verbose', 'warn']);
const SAFE_FORMATTERS = new Set(['formatErrorEvent', 'formatLogEvent']);

describe('logging policy', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('does not print raw exceptions or stacks', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (/\bconsole\.(?:debug|error)\s*\(/u.test(source)) violations.push(`${file}: raw console error`);
      if (/\.stack\b/u.test(source)) violations.push(`${file}: stack access`);
      if (file.replaceAll('\\', '/') !== 'scripts/cli-output.ts'
        && /process\.stderr\.write\s*\(/u.test(source)) violations.push(`${file}: direct stderr`);
    }
    expect(violations).toEqual([]);
  });

  it('requires Logger calls to use an event code or the safe formatter', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      visit(parsed, (call) => {
        if (!ts.isPropertyAccessExpression(call.expression)) return;
        if (!LOGGER_METHODS.has(call.expression.name.text)) return;
        const receiver = call.expression.expression.getText(parsed);
        if (receiver !== 'logger' && !receiver.endsWith('.logger') && !receiver.startsWith('new Logger(')) return;
        const first = call.arguments[0];
        if (first && ts.isStringLiteral(first) && /^[a-z][a-z0-9_]{0,63}$/u.test(first.text)) return;
        if (first && ts.isCallExpression(first) && ts.isIdentifier(first.expression)
          && SAFE_FORMATTERS.has(first.expression.text)) return;
        violations.push(`${file}:${parsed.getLineAndCharacterOfPosition(call.getStart()).line + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('keeps the deliberate one-time secret output limited to the bootstrap command', () => {
    const outputs = files.filter((file) => /process\.stdout\.write\s*\(/u.test(readFileSync(file, 'utf8')));
    expect(outputs.map((file) => file.replaceAll('\\', '/'))).toEqual([
      'scripts/create-admin-webauthn-bootstrap.ts',
    ]);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function visit(node: ts.Node, inspect: (call: ts.CallExpression) => void): void {
  if (ts.isCallExpression(node)) inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
