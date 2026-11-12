import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (!process.argv.includes('--live'))
  throw new Error(
    'Pass --live to run bounded, read-only requests against the public ParityDiff API.',
  );
const startedAt = new Date().toISOString();
const entry = fileURLToPath(new URL('./server.mjs', import.meta.url));
const execute = promisify(execFile);
const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let id = 0;
let stderr = '';
const waiting = new Map();
const checks = [];
let directRequests = 0;
let toolRequests = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  try {
    const result = JSON.parse(line);
    assert.equal(result.jsonrpc, '2.0');
    const pending = waiting.get(result.id);
    assert.ok(pending, 'Unexpected stdout message');
    waiting.delete(result.id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  } catch (error) {
    for (const pending of waiting.values()) pending.reject(error);
  }
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});
child.on('error', (error) => {
  for (const pending of waiting.values()) pending.reject(error);
});
child.on('exit', () => {
  for (const pending of waiting.values())
    pending.reject(new Error('MCP child exited during a request'));
});
function rpc(method, params) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      reject(new Error('MCP response timeout: ' + method));
    }, 25000);
    waiting.set(requestId, { resolve, reject, timer });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) }) +
        '\n',
    );
  });
}
async function check(name, run) {
  const start = performance.now();
  try {
    const details = await run();
    checks.push({
      name,
      passed: true,
      durationMs: Math.round(performance.now() - start),
      ...details,
    });
    console.log('PASS ' + name + (details ? ' ' + JSON.stringify(details) : ''));
    return details;
  } catch (error) {
    checks.push({
      name,
      passed: false,
      durationMs: Math.round(performance.now() - start),
      error: String(error),
    });
    console.log('FAIL ' + name + ': ' + String(error));
    return null;
  }
}
async function direct(source) {
  const url = new URL(source);
  assert.equal(url.origin, 'https://api.paritydiff.com');
  assert.ok(url.pathname.startsWith('/v1/public/apis'));
  assert.ok(++directRequests <= 30, 'Direct request budget exceeded');
  const response = await fetch(url, {
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, 'Direct API response failed: ' + source);
  return response.json();
}
async function call(name, args = {}) {
  toolRequests++;
  assert.ok(toolRequests <= 30, 'Tool request budget exceeded');
  const response = await rpc('tools/call', { name, arguments: args });
  assert.ok(!response.error, JSON.stringify(response.error));
  assert.ok(!response.result.isError, JSON.stringify(response.result));
  assert.equal(response.result.content.length, 1);
  const evidence = JSON.parse(response.result.content[0].text);
  assert.ok(Number.isFinite(Date.parse(evidence.fetchedAt)));
  assert.match(evidence.limits, /Empty results do not establish compatibility/);
  const baseline = await direct(evidence.source);
  const expected =
    name === 'list_release_changes' && (args.method || args.path)
      ? {
          ...baseline,
          scannedFindings: baseline.data.length,
          data: baseline.data.filter(
            (row) =>
              (!args.method || row.method === args.method) &&
              (!args.path || row.path === args.path),
          ),
        }
      : baseline;
  assert.deepEqual(evidence.data, expected, 'MCP result differs from direct public API');
  if (name === 'list_release_changes') {
    const breaking = expected.data.some((row) => row.classification === 'breaking');
    assert.equal(Boolean(evidence.meta?.upgrade_hint), breaking);
    if (breaking) {
      const setup = new URL(evidence.meta.upgrade_hint.url);
      assert.equal(setup.origin + setup.pathname, 'https://paritydiff.com/start');
      assert.deepEqual(Object.fromEntries(setup.searchParams), {
        scan: '1',
        vendor: args.vendor,
        release: args.release,
        ref: 'mcp',
      });
    }
  }
  return evidence;
}

try {
  await check('rejects tool requests before initialization', async () => {
    assert.equal((await rpc('tools/list')).error.code, -32000);
  });
  await check('real stdio initialization and tool discovery', async () => {
    const greeting = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'paritydiff-e2e', version: '1.0' },
      capabilities: {},
    });
    assert.equal(greeting.result.protocolVersion, '2025-11-25');
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    const tools = (await rpc('tools/list')).result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['list_apis', 'get_api', 'get_provider_migration', 'list_releases', 'list_release_changes'],
    );
    return { tools: tools.length };
  });
  let catalog;
  await check('catalog page 1 matches direct API', async () => {
    catalog = await call('list_apis', { limit: 3 });
    assert.equal(catalog.data.data.length, 3);
    assert.ok(catalog.data.nextCursor);
    return { vendors: catalog.data.data.map((row) => row.id) };
  });
  if (catalog)
    await check('catalog page 2 uses the returned cursor without duplicates', async () => {
      const next = await call('list_apis', { limit: 3, cursor: catalog.data.nextCursor });
      assert.ok(
        next.data.data.every(
          (row) => !catalog.data.data.some((previous) => previous.id === row.id),
        ),
      );
      return { vendors: next.data.data.map((row) => row.id) };
    });
  for (const vendor of ['sentry', 'openai', 'asana', 'pagerduty'])
    await check('API detail matches direct API: ' + vendor, async () => {
      const evidence = await call('get_api', { vendor });
      assert.equal(evidence.data.id, vendor);
      assert.equal(evidence.coverage.operationsComplete, false);
      assert.equal(evidence.coverage.operationsScope, 'preview');
      assert.equal(evidence.coverage.returnedOperations, evidence.data.operations.length);
      return {
        operations: evidence.data.operations.length,
        recordedReleases: evidence.data.releaseCount,
        latestCapture: evidence.data.latestSpec?.lastCapturedAt,
      };
    });
  let releases;
  await check('Sentry release page matches direct API', async () => {
    releases = await call('list_releases', { vendor: 'sentry', limit: 2 });
    assert.equal(releases.data.data.length, 2);
    assert.ok(releases.data.nextCursor);
    return {
      ids: releases.data.data.map((row) => row.id),
      statuses: releases.data.data.map((row) => row.status),
    };
  });
  if (releases)
    await check('release page 2 matches direct API without duplicates', async () => {
      const next = await call('list_releases', {
        vendor: 'sentry',
        limit: 2,
        cursor: releases.data.nextCursor,
      });
      assert.ok(
        next.data.data.every(
          (row) => !releases.data.data.some((previous) => previous.id === row.id),
        ),
      );
      return { records: next.data.data.length };
    });
  await check(
    'release check CLI matches the direct public release and exits with its classification',
    async () => {
      const example = JSON.parse(
        await readFile(
          new URL('../../apps/app/src/playground/openai-example.json', import.meta.url),
          'utf8',
        ),
      );
      const release = example.release.id;
      const source =
        'https://api.paritydiff.com/v1/public/apis/openai/releases/' + encodeURIComponent(release);
      const baseline = await direct(source);
      const incomplete =
        ['pending', 'partial'].includes(baseline.status) ||
        baseline.counts.pending > 0 ||
        baseline.counts.ambiguous > 0;
      const expectedExit = baseline.counts.breaking > 0 ? 1 : incomplete ? 3 : 0;
      let exitCode = 0;
      let output;
      try {
        output = await execute(
          process.execPath,
          [entry, 'check', '--vendor', 'openai', '--release', release],
          { timeout: 25000, maxBuffer: 65536, windowsHide: true },
        );
      } catch (error) {
        exitCode = error.code;
        output = error;
      }
      assert.equal(output.stderr, '');
      assert.equal(exitCode, expectedExit);
      const report = JSON.parse(output.stdout);
      assert.equal(report.releaseId, release);
      assert.equal(report.source, source);
      assert.equal(report.status, baseline.status);
      assert.equal(report.incomplete, incomplete);
      assert.equal(report.repositoryScanned, false);
      assert.deepEqual(report.counts, baseline.counts);
      return { release, exitCode, counts: report.counts };
    },
  );
  for (const vendor of ['sentry', 'openai']) {
    const example = JSON.parse(
      await readFile(
        new URL(`../../apps/app/src/playground/${vendor}-example.json`, import.meta.url),
        'utf8',
      ),
    );
    const found = [];
    let cursor;
    for (let page = 1; page <= 3; page++) {
      const result = await check(
        `${vendor} captured finding page ${page} matches direct API`,
        async () => {
          const evidence = await call('list_release_changes', {
            vendor,
            release: example.release.id,
            limit: vendor === 'sentry' ? 2 : 50,
            ...(cursor ? { cursor } : {}),
          });
          found.push(...evidence.data.data);
          cursor = evidence.data.nextCursor;
          return { records: evidence.data.data.length, hasMore: Boolean(cursor) };
        },
      );
      if (!result || !cursor) break;
    }
    await check(
      `${vendor} historical example retains its expected operation and evidence`,
      async () => {
        const match = found.find((row) => row.id === example.change.id);
        assert.ok(match, 'Historical example was absent after pagination');
        assert.equal(match.path, example.change.path);
        assert.equal(match.method, example.change.method);
        assert.ok(match.ruleId);
        assert.ok(Array.isArray(match.fragment));
        return {
          finding: match.id,
          rule: match.ruleId,
          classification: match.classification,
          capturedFindings: found.length,
          historicalSnapshotFindings: example.release.recordedChanges,
        };
      },
    );
    if (vendor === 'sentry') {
      await check('exact endpoint filter matches the direct-page subset', async () => {
        const evidence = await call('list_release_changes', {
          vendor,
          release: example.release.id,
          method: example.change.method,
          path: example.change.path,
          limit: 50,
        });
        assert.ok(evidence.data.data.some((row) => row.id === example.change.id));
        return { matches: evidence.data.data.length, scanned: evidence.data.scannedFindings };
      });
      await check('nonmatching endpoint returns an empty result with evidence limits', async () => {
        const evidence = await call('list_release_changes', {
          vendor,
          release: example.release.id,
          method: 'GET',
          path: '/paritydiff-e2e-no-such-operation',
          limit: 50,
        });
        assert.equal(evidence.data.data.length, 0);
        assert.ok(evidence.data.scannedFindings > 0);
        return { matches: 0, scanned: evidence.data.scannedFindings };
      });
    }
  }
  await check('invalid arguments return a protocol error', async () => {
    const result = await rpc('tools/call', {
      name: 'get_api',
      arguments: { vendor: '../private' },
    });
    assert.equal(result.error.code, -32602);
  });
  await check('unknown public vendor fails as a tool error', async () => {
    const result = await rpc('tools/call', {
      name: 'get_api',
      arguments: { vendor: 'paritydiff-mcp-no-such-vendor' },
    });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /do not infer compatibility/);
  });
  await check('stdout remains valid JSON-RPC and stderr remains empty', async () => {
    assert.deepEqual((await rpc('ping')).result, {});
    assert.equal(stderr, '');
  });
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => {
      child.kill();
      resolve();
    }, 3000).unref();
  });
  lines.close();
  for (const pending of waiting.values()) clearTimeout(pending.timer);
}
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  server: 'tools/mcp/server.mjs',
  liveOrigin: 'https://api.paritydiff.com',
  passed: checks.filter((check) => check.passed).length,
  failed: checks.filter((check) => !check.passed).length,
  directRequests,
  toolRequests,
  checks,
};
const reportPath = new URL('../../tmp/mcp-e2e-live.json', import.meta.url);
await mkdir(new URL('./', reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    passed: report.passed,
    failed: report.failed,
    report: fileURLToPath(reportPath),
  }),
);
if (report.failed) process.exitCode = 1;
