import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dirname);
const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
const registry = JSON.parse(await readFile(resolve(directory, 'server.json'), 'utf8'));
const source = await readFile(resolve(directory, 'server.mjs'), 'utf8');
const command = process.argv[2];
const tag = process.env.GITHUB_REF_NAME;
const expectedRepository = 'soumik15630m/yc';
assert.equal(process.env.GITHUB_REPOSITORY ?? expectedRepository, expectedRepository);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(tag ?? 'mcp-v' + manifest.version, 'mcp-v' + manifest.version);
assert.equal(manifest.name, '@paritydiff/mcp');
assert.equal(registry.version, manifest.version);
assert.equal(registry.packages[0].version, manifest.version);
assert.equal(registry.packages[0].identifier, manifest.name);
assert.ok(source.includes("version: '" + manifest.version + "'"));
assert.equal(manifest.repository.url, 'git+https://github.com/' + expectedRepository + '.git');
assert.equal(manifest.repository.directory, 'tools/mcp');
const filename = 'paritydiff-mcp-' + manifest.version + '.tgz';
const output = resolve(directory, '../../tmp/mcp-release');

if (command === 'pack') {
  await mkdir(output, { recursive: true });
  const npm = process.platform === 'win32' ? process.env.npm_execpath : undefined;
  if (process.platform === 'win32')
    assert.ok(npm, 'Run packing through npm run release:pack on Windows');
  const result = JSON.parse(
    execFileSync(
      npm ? process.execPath : 'npm',
      [...(npm ? [npm] : []), 'pack', '--json', '--ignore-scripts', '--pack-destination', output],
      {
        cwd: directory,
        encoding: 'utf8',
      },
    ),
  );
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].files.map((file) => file.path).sort(), [
    'LICENSE',
    'README.md',
    'local-check.mjs',
    'local-syntax.mjs',
    'package.json',
    'server.json',
    'server.mjs',
  ]);
  const bytes = await readFile(resolve(output, filename));
  await writeFile(
    resolve(output, 'SHA256SUMS'),
    createHash('sha256').update(bytes).digest('hex') + '  ' + filename + '\n',
  );
  await writeFile(resolve(output, 'server.json'), JSON.stringify(registry, null, 2) + '\n');
  console.log('Verified release archive ' + filename);
} else if (command === 'verify-published' || command === 'publication-status') {
  const bytes = await readFile(resolve(output, filename));
  const expected = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(
      'https://registry.npmjs.org/@paritydiff%2fmcp/' + manifest.version,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'cache-control': 'no-cache' },
      },
    );
    if (response.ok) {
      const published = await response.json();
      assert.equal(published.version, manifest.version);
      assert.equal(published.dist.integrity, expected);
      if (command === 'publication-status' && process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, 'published=true\n');
      console.log('Verified public npm release and tarball integrity');
      process.exit(0);
    }
    assert.equal(response.status, 404, 'Unexpected npm registry response');
    await response.body?.cancel();
    if (command === 'publication-status') {
      if (process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, 'published=false\n');
      process.exit(0);
    }
    await new Promise((done) => setTimeout(done, 5000));
  }
  throw new Error('Version is unavailable publicly. Inspect npm staged releases before retrying.');
} else {
  throw new Error('Use pack, publication-status or verify-published');
}
