import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { localCalls } from './local-syntax.mjs';

const git = promisify(execFile);
const maxFiles = 2000;
const maxFileBytes = 512 * 1024;
const maxTotalBytes = 32 * 1024 * 1024;
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);

function pathMatches(template, path) {
  const expected = template.split('/');
  const actual = path.split('/');
  return (
    expected.length === actual.length &&
    expected.every(
      (segment, index) =>
        segment === actual[index] || (/^\{[^{}/]+\}$/.test(segment) && Boolean(actual[index])),
    )
  );
}

async function readSource(root, file, limit) {
  const segments = file.split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'),
    )
  )
    return null;
  const path = join(root, ...segments);
  const target = await realpath(path);
  if (relative(root, target) !== segments.join(sep)) return null;
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > limit) return null;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const data = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    return bytesRead <= limit
      ? new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead))
      : null;
  } finally {
    await handle.close();
  }
}

export async function scanLocalHttp(directory, apiHost, changes, sdkMappings = []) {
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(apiHost ?? '') && !sdkMappings.length)
    return { scannedFiles: 0, skippedFiles: 0, matches: [], reason: 'no_exact_http_host' };
  const root = await realpath(resolve(directory));
  const listing = await git(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10000,
      windowsHide: true,
    },
  );
  const files = [...new Set(listing.stdout.split('\0'))].filter(
    (file) =>
      /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) &&
      !/(?:^|\/)(?:node_modules|dist|build|vendor)\//.test(file) &&
      !/\.d\.[cm]?ts$/.test(file),
  );
  let bytes = 0;
  let skipped = files.length - Math.min(maxFiles, files.length);
  const matches = [];
  let scanned = 0;
  let unresolvedCalls = 0;
  for (const file of files.slice(0, maxFiles)) {
    const limit = Math.min(maxFileBytes, maxTotalBytes - bytes);
    const source = limit > 0 ? await readSource(root, file, limit).catch(() => null) : null;
    if (source === null) {
      skipped++;
      continue;
    }
    bytes += Buffer.byteLength(source);
    const analysis = localCalls(file, source, sdkMappings);
    if (!analysis) {
      skipped++;
      continue;
    }
    scanned++;
    unresolvedCalls += analysis.unresolvedCalls;
    const seen = new Set();
    for (const call of analysis.calls) {
      if (matches.length >= 1000) break;
      let method = call.method,
        path;
      if (call.sdk) {
        method = call.sdk.method;
        path = call.sdk.path;
      } else {
        let url;
        try {
          url = new URL(call.url);
        } catch {
          continue;
        }
        if (url.protocol !== 'https:' || url.host !== apiHost || url.username || url.password)
          continue;
        path = url.pathname;
      }
      if (!methods.has(method)) {
        unresolvedCalls++;
        continue;
      }
      const findings = changes.filter(
        (change) => change.method === method && pathMatches(change.path, path),
      );
      if (!findings.length) continue;
      const key = JSON.stringify([
        call.line,
        method,
        findings.map((finding) => finding.id),
        call.sdk?.symbol,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        file,
        line: call.line,
        method,
        findingIds: findings.map((finding) => finding.id),
        ...(call.sdk
          ? {
              sdkPackage: call.sdk.packageName,
              sdkSymbol: call.sdk.symbol,
              affectedRange: call.sdk.affectedRange,
              versionGate: 'unresolved',
            }
          : {}),
      });
    }
  }
  return {
    scannedFiles: scanned,
    skippedFiles: skipped,
    matches,
    unresolvedCalls,
    truncated: matches.length >= 1000,
  };
}
