import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const testFilePattern = /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/;

describe('test layout', () => {
  it('keeps every test file under the test directory', async () => {
    const workspace = process.cwd();
    const testDirectory = join(workspace, 'test');
    const files = await findTestFiles(workspace);
    const outsideTestDirectory = files
      .filter((file) => file !== testDirectory && !file.startsWith(`${testDirectory}${sep}`))
      .map((file) => relative(workspace, file));

    expect(outsideTestDirectory).toEqual([]);
  });
});

async function findTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : findTestFiles(join(directory, entry.name));
    }
    const path = join(directory, entry.name);
    return testFilePattern.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}
