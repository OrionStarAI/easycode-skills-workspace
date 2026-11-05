#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://skills.deepvlab.ai';
const catalogs = ['expert-templates', 'mcp-servers'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Small, allowlisted client. Never accepts a URL or credential on the command line. */
export async function run(args, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const loadFile = options.readFile ?? readFile;
  const out = options.out ?? ((value) => console.log(value));
  const err = options.err ?? ((value) => console.error(value));
  const [command, arg, ...extra] = args;
  if (extra.length || !['status', 'sync', 'compare'].includes(command)
      || (command === 'status' && arg) || ((command === 'sync' || command === 'compare') && !arg)) {
    err('Usage: marketplace-api.mjs status | sync <source-id> | compare <source-repo-path>');
    return 2;
  }
  if (command === 'sync' && (arg.length > 128 || /[\r\n]/.test(arg))) {
    err('Invalid source ID.');
    return 2;
  }
  try {
    if (command === 'compare') {
      const results = [];
      for (const name of catalogs) {
        const local = JSON.parse(await loadFile(path.join(arg, 'catalog', `${name}.json`), 'utf8'));
        const response = await fetchImpl(`${ORIGIN}/api/${name}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error('catalog_unavailable');
        const live = await response.json();
        if (!Array.isArray(local.items) || !Array.isArray(live.items)) throw new Error('invalid_catalog');
        results.push({
          catalog: name,
          matches: JSON.stringify(canonical(local.items)) === JSON.stringify(canonical(live.items)),
          localCount: local.items.length,
          liveCount: live.items.length,
          liveMeta: { source: live.meta?.source ?? null, commit: live.meta?.commit ?? null, syncedAt: live.meta?.syncedAt ?? null },
        });
      }
      out(JSON.stringify({ ok: true, catalogs: results }));
      return 0;
    }
    const token = env.EASYCODE_MARKET_AUTOMATION_TOKEN;
    if (!token) {
      err('Automation credential is not configured. Set EASYCODE_MARKET_AUTOMATION_TOKEN securely; do not paste it into chat.');
      return 2;
    }
    const endpoint = command === 'status' ? '/api/automation/status' : `/api/automation/sources/${encodeURIComponent(arg)}/sync`;
    const response = await fetchImpl(ORIGIN + endpoint, {
      method: command === 'sync' ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(command === 'sync' ? 300_000 : 15_000),
    });
    let body;
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok || body.ok !== true) {
      out(JSON.stringify({ ok: false, httpStatus: response.status, code: body.code ?? 'request_failed', requestId: body.requestId ?? null, synced: body.synced ?? null, errorCount: body.errorCount ?? null }));
      return 1;
    }
    if (command === 'status') {
      out(JSON.stringify({ ok: true, scheduler: body.scheduler, sources: body.sources }));
    } else {
      out(JSON.stringify({ ok: true, synced: body.synced, requestId: body.requestId }));
    }
    return 0;
  } catch {
    err(command === 'sync'
      ? 'Sync result is unknown: the request timed out or failed. Check status and server logs before trying again.'
      : 'Unable to complete the read-only check. Check the path and network connection.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
