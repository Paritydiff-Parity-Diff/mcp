import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  authorizeDevice,
  callTool,
  checkRelease,
  createHandler,
  serve,
  TOOLS,
  PRIVATE_TOOLS,
  MIGRATION_TOOLS,
} from './server.mjs';

const request = (method, params, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
});
const initialize = request('initialize', {
  protocolVersion: '2025-11-25',
  clientInfo: { name: 'fixture', version: '1' },
  capabilities: {},
});
const page = (data = [], nextCursor = null) =>
  new Response(JSON.stringify({ data, nextCursor }), {
    headers: { 'content-type': 'application/json' },
  });

const releaseRecord = (overrides = {}) => ({
  id: 'rel_example',
  detectedAt: '2026-10-16T20:00:00Z',
  status: 'classified',
  counts: { breaking: 1, non_breaking: 2, ambiguous: 0, deprecation: 0, pending: 0 },
  ...overrides,
});
const recordResponse = (record) => Response.json(record);

test('matches captured endpoints locally without treating shadowed fetch or lookalike hosts as usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paritydiff-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await writeFile(
      join(dir, 'client.ts'),
      [
        "fetch('https://api.example.com/v1/items/abc?secret=fixture');",
        "fetch('https://api.example.com.other.net/v1/items/abc');",
        "function local(fetch: (s: string) => void) { fetch('https://api.example.com/v1/items/abc'); }",
        "fetch('https://api.example.com/v1/items/abc', { method: 'POST' });",
      ].join('\n'),
    );
    const { report } = await checkRelease(
      'example',
      'rel_example',
      async (url) => {
        if (url.pathname.endsWith('/changes'))
          return page([
            { id: 'finding1', method: 'GET', path: '/v1/items/{id}', classification: 'breaking' },
          ]);
        if (url.pathname.endsWith('/rel_example')) return recordResponse(releaseRecord());
        return recordResponse({ id: 'example', httpBase: 'api.example.com' });
      },
      dir,
    );
    assert.equal(report.repositoryScanned, true);
    assert.equal(report.local.findingsComplete, true);
    assert.deepEqual(report.local.matches, [
      { file: 'client.ts', line: 1, method: 'GET', findingIds: ['finding1'] },
    ]);
    assert.ok(!JSON.stringify(report).includes('secret=fixture'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('requests and saves private scope only after the device grant returns the same scope', async () => {
  let time = Date.parse('2030-01-01T00:00:00Z');
  const scope = 'workspace:read contracts:read';
  const result = await authorizeDevice({
    privateContracts: true,
    prompt: () => {},
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.pathname.endsWith('/authorize')) {
        assert.equal(body.scope, scope);
        return Response.json({
          device_code: 'a'.repeat(64),
          user_code: 'ABCD2345',
          verification_uri: 'https://paritydiff.com/mcp/connect',
          expires_in: 600,
          interval: 5,
        });
      }
      return Response.json({
        access_token: 'pdm_' + 'b'.repeat(64),
        token_type: 'Bearer',
        scope,
        expires_at: new Date(time + 28_800_000).toISOString(),
      });
    },
  });
  assert.equal(result.scope, scope);
});

test('binds imported clients and SDK aliases, resolves finite URLs, and rejects mutable or shadowed bindings', async () => {
  const { localCalls } = await import('./local-syntax.mjs');
  const sdk = {
    language: 'typescript',
    packageName: 'vendor-sdk',
    moduleSpecifiers: ['vendor-sdk'],
    symbol: 'items.create',
    method: 'POST',
    path: '/v1/items',
    affectedRange: '<2',
  };
  const source = [
    "import http from 'axios'; import {fetch as send} from 'undici'; import Vendor from 'vendor-sdk';",
    "const base = 'https://api.example.com'; const id = true ? 'a' : 'b';",
    'send(`${base}/v1/items/${id}`, {method: "GET"});',
    "http.post(base + '/v1/items', {});",
    'const sdk = new Vendor({}); const items = sdk.items; items.create({});',
    'function shadow(http: any, sdk: any) { http.post("ignore"); sdk.items.create({}); }',
    'send(runtimeUrl);',
    "const mutable = {method:'GET'}; mutable.method='POST'; send(base, mutable);",
    'const fetcher = fetch; fetcher(base);',
  ].join('\n');
  const result = localCalls('client.ts', source, [sdk]);
  assert.equal(result.unresolvedCalls, 2);
  assert.deepEqual(result.calls, [
    { line: 3, url: 'https://api.example.com/v1/items/a', method: 'GET' },
    { line: 3, url: 'https://api.example.com/v1/items/b', method: 'GET' },
    { line: 4, url: 'https://api.example.com/v1/items', method: 'POST' },
    { line: 5, sdk },
    { line: 9, url: 'https://api.example.com', method: 'GET' },
  ]);
  assert.equal(localCalls('broken.ts', 'const value = ;'), null);
  assert.deepEqual(
    localCalls(
      'mutated.ts',
      "import http from 'axios'; http.post = replacement; http.post('https://api.example.com');",
    ).calls,
    [],
  );
});

test('paginates public SDK mappings before matching a repository without uploading source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paritydiff-sdk-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await writeFile(
      join(dir, 'client.ts'),
      "import Vendor from 'vendor-sdk'; const client = new Vendor({}); client.items.create({ privateCustomerData: 'stays local' });",
    );
    const calls = [];
    const result = await checkRelease(
      'example',
      'rel_example',
      async (url, init) => {
        calls.push({ url: url.href, init });
        if (url.pathname.endsWith('/sdk-mappings'))
          return page([
            {
              language: 'typescript',
              packageName: 'vendor-sdk',
              moduleSpecifiers: ['vendor-sdk'],
              symbol: 'items.create',
              method: 'POST',
              path: '/v1/items',
              affectedRange: '<2',
            },
          ]);
        if (url.pathname.endsWith('/changes'))
          return page([
            { id: 'finding1', method: 'POST', path: '/v1/items', classification: 'breaking' },
          ]);
        if (url.pathname.endsWith('/rel_example')) return recordResponse(releaseRecord());
        return recordResponse({
          id: 'example',
          httpBase: 'api.example.com',
          sdkPackages: ['vendor-sdk'],
        });
      },
      dir,
    );
    assert.equal(result.report.local.sdkMappingsComplete, true);
    assert.deepEqual(result.report.local.matches, [
      {
        file: 'client.ts',
        line: 1,
        method: 'POST',
        findingIds: ['finding1'],
        sdkPackage: 'vendor-sdk',
        sdkSymbol: 'items.create',
        affectedRange: '<2',
        versionGate: 'unresolved',
      },
    ]);
    assert.ok(!JSON.stringify(calls).includes('privateCustomerData'));
    assert.ok(calls.every(({ init }) => init.method === 'GET' && !init.body));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exposes scoped private contract tools with account-only authorization and strict workspace binding', async () => {
  const token = 'pdm_' + 'a'.repeat(64);
  const calls = [];
  const handle = createHandler(
    async (url, options) => {
      calls.push(String(url));
      assert.equal(new URL(url).origin, 'https://api.paritydiff.com');
      assert.equal(options.headers.authorization, 'Bearer ' + token);
      return page([{ id: 'private-fixture' }], 'next_fixture');
    },
    async () => ({
      access_token: token,
      expires_at: '2099-01-01T00:00:00Z',
      scope: 'workspace:read contracts:read',
    }),
  );
  await handle(initialize);
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = (await handle(request('tools/list'))).result.tools.map((tool) => tool.name);
  assert.ok(PRIVATE_TOOLS.every((tool) => tools.includes(tool.name)));
  const invalid = await handle(
    request('tools/call', {
      name: 'get_private_contract',
      arguments: { vendor: 'private-fixture', workspaceId: 'other' },
    }),
  );
  assert.equal(invalid.error.code, -32602);
  assert.equal(calls.length, 0);
  const result = await handle(
    request('tools/call', {
      name: 'list_private_release_changes',
      arguments: {
        vendor: 'private-fixture',
        release: 'rel_private',
        cursor: 'chg_previous',
        limit: 5,
      },
    }),
  );
  assert.equal(result.result.isError, undefined);
  assert.equal(JSON.parse(result.result.content[0].text).nextCursor, 'next_fixture');
  assert.equal(
    calls[0],
    'https://api.paritydiff.com/v1/mcp/contracts/private-fixture/releases/rel_private/changes?after=chg_previous&limit=5',
  );
});

test('requires explicit repair scope and consent, sends bounded drafts only to the account API', async () => {
  const calls = [];
  let validated = false;
  const token = 'pdm_' + 'c'.repeat(64);
  const access = {
    access_token: token,
    expires_at: '2099-01-01T00:00:00Z',
    scope: 'workspace:read migrations:write',
  };
  const handle = createHandler(
    async (url, options) => {
      calls.push({ url: String(url), options });
      assert.equal(new URL(url).origin, 'https://api.paritydiff.com');
      assert.equal(options.headers.authorization, 'Bearer ' + token);
      return Response.json({ validatedForReview: validated, cached: true });
    },
    async () => access,
  );
  await handle(initialize);
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = (await handle(request('tools/list'))).result.tools;
  assert.ok(MIGRATION_TOOLS.every((tool) => tools.some((item) => item.name === tool.name)));
  assert.equal(
    tools.find((tool) => tool.name === 'draft_validated_migration').annotations.readOnlyHint,
    false,
  );
  assert.ok(!tools.some((tool) => tool.name === 'list_private_contracts'));
  const args = {
    reviewSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    expectedAttempt: 0,
    feedback: 'Preserve metadata.',
    sendSource: true,
  };
  const call = (argumentsValue) =>
    handle(request('tools/call', { name: 'draft_validated_migration', arguments: argumentsValue }));
  for (const invalid of [
    { ...args, sendSource: false },
    { ...args, expectedAttempt: 2 },
    { ...args, workspaceId: 'other' },
  ])
    assert.equal((await call(invalid)).error.code, -32602);
  assert.equal(calls.length, 0);
  assert.equal((await call(args)).result.isError, true);
  assert.equal(calls[0].url, 'https://api.paritydiff.com/v1/mcp/migrations/draft');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), args);
  validated = true;
  assert.notEqual((await call(args)).result.isError, true);
  access.scope = 'workspace:read';
  const count = calls.length;
  assert.equal((await call(args)).result.isError, true);
  assert.equal(calls.length, count);
});

test('bounds private contract responses and preserves workspace upgrade hints for repair failures', async () => {
  let mode = 'private';
  const hint = {
    message: 'More credits required',
    url: 'https://paritydiff.com/subscribe?workspace_id=fixture',
  };
  const handle = createHandler(
    async () =>
      mode === 'private'
        ? Response.json({ data: 'x'.repeat(1024 * 1024 + 1) })
        : Response.json(
            { error: 'repair_access_or_credits_required', meta: { upgrade_hint: hint } },
            { status: 402 },
          ),
    async () => ({
      access_token: 'pdm_' + 'd'.repeat(64),
      expires_at: '2099-01-01T00:00:00Z',
      scope: 'workspace:read contracts:read migrations:write',
    }),
  );
  await handle(initialize);
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(
    (await handle(request('tools/call', { name: 'list_private_contracts', arguments: {} }))).result
      .isError,
    true,
  );
  mode = 'repair';
  const result = (
    await handle(
      request('tools/call', {
        name: 'draft_validated_migration',
        arguments: {
          reviewSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          expectedAttempt: 0,
          feedback: 'Preserve metadata.',
          sendSource: true,
        },
      }),
    )
  ).result;
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text).meta.upgrade_hint, hint);
});

test('waits for browser approval, backs off and exchanges only the device secret', async () => {
  let time = Date.parse('2026-11-11T10:00:00Z');
  const device = 'a'.repeat(64);
  const token = 'pdm_' + 'b'.repeat(64);
  const delays = [];
  const polls = ['authorization_pending', 'slow_down', 'issued'];
  const result = await authorizeDevice({
    now: () => time,
    sleep: async (ms) => {
      delays.push(ms);
      time += ms;
    },
    prompt: (url, code) => {
      assert.equal(url, 'https://paritydiff.com/mcp/connect');
      assert.equal(code, 'ABCD2345');
    },
    fetcher: async (url, init) => {
      assert.equal(url.origin, 'https://api.paritydiff.com');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, undefined);
      const body = JSON.parse(init.body);
      assert.equal(body.client_id, 'paritydiff-mcp');
      if (url.pathname.endsWith('/authorize'))
        return Response.json({
          device_code: device,
          user_code: 'ABCD2345',
          verification_uri: 'https://paritydiff.com/mcp/connect',
          expires_in: 600,
          interval: 5,
        });
      assert.equal(body.device_code, device);
      assert.equal(body.user_code, undefined);
      const next = polls.shift();
      if (next !== 'issued') return Response.json({ error: next }, { status: 400 });
      return Response.json({
        access_token: token,
        token_type: 'Bearer',
        scope: 'workspace:read',
        expires_at: new Date(time + 28800000).toISOString(),
      });
    },
  });
  assert.equal(result.access_token, token);
  assert.deepEqual(delays, [5000, 5000, 10000]);
});

test('keeps the credential off public requests and cannot override the connected workspace', async () => {
  const token = 'pdm_' + 'b'.repeat(64);
  const expires = '2026-11-11T18:00:00.000Z';
  const handle = createHandler(
    async (url, init) => {
      if (url.pathname === '/v1/mcp/workspace') {
        assert.equal(init.headers.authorization, 'Bearer ' + token);
        return Response.json({
          workspaceId: 'tenant-1',
          workspaceName: 'Example',
          role: 'member',
          plan: 'free',
          expiresAt: expires,
        });
      }
      assert.equal(init.headers.authorization, undefined);
      return page();
    },
    async () => ({ access_token: token, expires_at: expires }),
  );
  await handle(initialize);
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await handle(request('tools/list'))).result.tools.at(-1).name, 'get_workspace');
  const valid = await handle(request('tools/call', { name: 'get_workspace', arguments: {} }));
  assert.equal(JSON.parse(valid.result.content[0].text).workspaceId, 'tenant-1');
  assert.equal(
    (
      await handle(
        request('tools/call', { name: 'get_workspace', arguments: { workspaceId: 'tenant-2' } }),
      )
    ).error.code,
    -32602,
  );
  assert.equal(
    (await handle(request('tools/call', { name: 'list_apis', arguments: {} }))).result.isError,
    undefined,
  );
});

test('checks a captured release ID and distinguishes incomplete evidence from a complete release', async () => {
  const record = releaseRecord();
  const check = (value) =>
    checkRelease('openai', record.id, async (url, options) => {
      assert.equal(
        url.href,
        'https://api.paritydiff.com/v1/public/apis/openai/releases/rel_example',
      );
      assert.equal(options.credentials, 'omit');
      return recordResponse(value);
    });
  const result = await check(record);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.repositoryScanned, false);
  assert.deepEqual(result.report.counts, record.counts);
  const counts = { ...record.counts, breaking: 0 };
  assert.equal((await check({ ...record, counts })).exitCode, 0);
  assert.equal(
    (await check({ ...record, status: 'partial', counts: { ...counts, pending: 1 } })).exitCode,
    3,
  );
  await assert.rejects(check({ ...record, id: 'wrong' }), /requested selector/);
  await assert.rejects(
    check({ ...record, counts: { ...counts, breaking: -1 } }),
    /Invalid public release record/,
  );
});

test('follows bound release cursors and rejects ambiguous UTC dates or cursor loops', async () => {
  const record = releaseRecord();
  let lookups = 0;
  const selector = '2026-10-16';
  const check = (other, nextCursor = null) =>
    checkRelease('openai', selector, async (url) => {
      if (url.pathname.endsWith(record.id)) return recordResponse(record);
      lookups++;
      assert.equal(url.searchParams.get('since'), '2026-10-16T00:00:00.000Z');
      return url.searchParams.has('cursor') ? page(other, nextCursor) : page([record], 'next');
    });
  assert.equal(
    (await check([releaseRecord({ id: 'later', detectedAt: '2026-10-17T00:00:00Z' })])).report
      .releaseId,
    record.id,
  );
  assert.equal(lookups, 2);
  await assert.rejects(check([releaseRecord({ id: 'same_day' })]), /Multiple releases/);
  await assert.rejects(check([], 'next'), /Repeated release cursor/);
  await assert.rejects(
    checkRelease('openai', '2026-02-30', async () => assert.fail('unexpected fetch')),
    /Invalid release date/,
  );
});

test('adds the upgrade hint only when returned changes contain a breaking classification', async () => {
  const fetcher = async () =>
    page([
      { method: 'GET', path: '/v1/a', classification: 'breaking' },
      { method: 'GET', path: '/v1/b', classification: 'deprecation' },
    ]);
  const args = { vendor: 'openai', release: 'rel_example' };
  const visible = JSON.parse(
    (await callTool('list_release_changes', args, fetcher)).content[0].text,
  );
  assert.equal(
    visible.meta.upgrade_hint.url,
    'https://paritydiff.com/start?scan=1&vendor=openai&release=rel_example&ref=mcp',
  );
  const filtered = JSON.parse(
    (await callTool('list_release_changes', { ...args, path: '/v1/b' }, fetcher)).content[0].text,
  );
  assert.equal(filtered.meta, undefined);
});

test('negotiates the lifecycle before exposing read-only tools', async () => {
  const handle = createHandler();
  assert.equal((await handle(request('tools/list'))).error.code, -32000);
  const result = (await handle(initialize)).result;
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal((await handle(request('tools/list'))).error.code, -32000);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(
    (await handle(request('tools/list'))).result.tools.map((tool) => tool.name),
    TOOLS.map((tool) => tool.name),
  );
  assert.ok(TOOLS.every((tool) => tool.annotations.readOnlyHint));
  assert.equal((await handle(initialize)).error.code, -32602);
  assert.equal((await handle(request('unknown'))).error.code, -32601);
});

test('negotiates a supported version and handles invalid JSON-RPC envelopes', async () => {
  const handle = createHandler();
  assert.equal(
    (await handle({ ...initialize, params: { ...initialize.params, protocolVersion: 'future' } }))
      .result.protocolVersion,
    '2025-11-25',
  );
  for (const input of [
    null,
    [],
    { method: 'ping', id: 1 },
    request('ping', null, {}),
    request('ping', null, null),
  ])
    assert.equal((await handle(input)).error.code, -32600);
  assert.deepEqual((await handle(request('ping'))).result, {});
});

test('rejects arbitrary destinations, private slugs and malformed tool arguments before fetching', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return page();
  };
  for (const args of [
    { vendor: '../private' },
    { vendor: 'fixture-secret' },
    { vendor: 'valid', url: 'https://other.invalid' },
    { vendor: 'valid', limit: 51 },
    { vendor: 'valid', cursor: '../token' },
  ])
    await assert.rejects(() => callTool('list_releases', args, fetcher));
  await assert.rejects(() => callTool('not-a-tool', {}, fetcher));
  await assert.rejects(() =>
    callTool(
      'list_release_changes',
      { vendor: 'valid', release: 'r1', method: 'GET\nPOST' },
      fetcher,
    ),
  );
  await assert.rejects(() => callTool('get_api', { vendor: null }, fetcher));
  assert.equal(calls, 0);
});

test('uses only credential-free public GETs and preserves pagination provenance', async () => {
  let seen;
  const result = await callTool(
    'list_releases',
    { vendor: 'sentry', cursor: 'next_page', limit: 2 },
    async (url, options) => {
      seen = { url: url.href, options };
      return page([{ id: 'release1' }], 'more');
    },
  );
  assert.equal(
    seen.url,
    'https://api.paritydiff.com/v1/public/apis/sentry/releases?limit=2&cursor=next_page',
  );
  assert.equal(seen.options.credentials, 'omit');
  assert.equal(seen.options.redirect, 'error');
  assert.deepEqual(seen.options.headers, { accept: 'application/json' });
  const evidence = JSON.parse(result.content[0].text);
  assert.equal(evidence.data.nextCursor, 'more');
  assert.equal(evidence.source, seen.url);
  assert.match(evidence.limits, /untrusted reference data/);
});

test('matches native-call operations exactly without treating a filtered page as complete history', async () => {
  const result = await callTool(
    'list_release_changes',
    { vendor: 'sentry', release: 'r1', method: 'GET', path: '/events' },
    async () =>
      page(
        [
          { method: 'GET', path: '/events', classification: 'breaking' },
          { method: 'POST', path: '/events', classification: 'breaking' },
          { method: 'GET', path: '/events/other', classification: 'deprecation' },
        ],
        'older_findings',
      ),
  );
  const evidence = JSON.parse(result.content[0].text);
  assert.equal(evidence.data.data.length, 1);
  assert.equal(evidence.data.scannedFindings, 3);
  assert.equal(evidence.data.nextCursor, 'older_findings');
  assert.match(evidence.limits, /Empty results do not establish compatibility/);
});

test('validates endpoint records and every page boundary', async () => {
  const result = await callTool(
    'get_api',
    { vendor: 'sentry' },
    async () =>
      new Response(JSON.stringify({ id: 'sentry', operations: [], sdkPackages: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  assert.equal(JSON.parse(result.content[0].text).data.id, 'sentry');
  assert.deepEqual(JSON.parse(result.content[0].text).coverage, {
    operationsScope: 'preview',
    operationsComplete: false,
    returnedOperations: 0,
  });
  assert.match(
    JSON.parse(result.content[0].text).limits,
    /missing operation does not prove absence/,
  );
  for (const body of [
    { id: 'other', operations: [] },
    { data: [] },
    { data: [], nextCursor: '../bad' },
    { data: Array(21).fill({}), nextCursor: null },
  ]) {
    await assert.rejects(() =>
      callTool(
        'list_apis',
        {},
        async () =>
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      ),
    );
  }
});

test('fails closed on HTTP errors, wrong media types and oversized responses', async () => {
  const failures = [
    new Response('error', { status: 503 }),
    new Response('<html>unavailable</html>'),
    new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of failures)
    await assert.rejects(() => callTool('list_apis', {}, async () => response));
  const redirected = page();
  Object.defineProperty(redirected, 'url', { value: 'https://untrusted.invalid' });
  await assert.rejects(() => callTool('list_apis', {}, async () => redirected));
});

test('separates argument errors from tool failures without exposing provider error bodies', async () => {
  const handle = createHandler(async () => {
    throw new Error('sensitive transport details');
  });
  await handle(initialize);
  await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(
    (await handle(request('tools/call', { name: 'get_api', arguments: { vendor: '../bad' } })))
      .error.code,
    -32602,
  );
  const failure = await handle(request('tools/call', { name: 'list_apis', arguments: {} }));
  assert.equal(failure.result.isError, true);
  assert.ok(!JSON.stringify(failure).includes('sensitive transport'));
});

test('frames split stdio messages and recovers from malformed JSON', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => {
    text += chunk.toString();
  });
  const running = serve(input, output);
  const message = JSON.stringify(initialize) + '\n';
  input.write(message.slice(0, 17));
  input.end(message.slice(17) + 'invalid-json\n' + JSON.stringify(request('ping', null, 2)) + '\n');
  await running;
  const results = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(results.length, 3);
  assert.equal(results[0].result.serverInfo.name, '@paritydiff/mcp');
  assert.equal(results[1].error.code, -32700);
  assert.deepEqual(results[2].result, {});
});

test('bounds incomplete stdio messages and rejects unterminated messages', async () => {
  for (const body of ['x'.repeat(1024 * 1024 + 1), JSON.stringify(request('ping'))]) {
    const input = new PassThrough();
    const running = serve(input, new PassThrough());
    input.end(body);
    await assert.rejects(running);
  }
});
