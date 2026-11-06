#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://skills.deepvlab.ai';
const catalogs = ['expert-templates', 'mcp-servers'];
const SOURCE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)OrionStarAI\/easycode-skills-workspace(?:\.git)?\/?$/i;

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
  if (extra.length || !['status', 'sync', 'compare', 'admin-sync'].includes(command)
      || (command === 'status' && arg) || (command !== 'status' && !arg)) {
    err('Usage: marketplace-api.mjs status | sync <source-id> | compare <source-repo-path> | admin-sync <backend-repo-path>');
    return 2;
  }
  if (command === 'sync' && (arg.length > 128 || /[\r\n]/.test(arg))) {
    err('Invalid source ID.');
    return 2;
  }
  let submitted = false;
  try {
    if (command === 'compare') {
      const results = [];
      for (const name of catalogs) {
        const local = JSON.parse(await loadFile(path.join(arg, 'catalog', `${name}.json`), 'utf8'));
        const suffix = name === 'expert-templates' ? '?capabilities=expert-profiles-v1' : '';
        const response = await fetchImpl(`${ORIGIN}/api/${name}${suffix}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
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
    if (command === 'admin-sync') {
      let documentation;
      try {
        documentation = await loadFile(path.join(arg, 'docs', 'ADMIN_ACCESS.md'), 'utf8');
      } catch {
        err('Admin access documentation is missing or unreadable.');
        return 1;
      }
      const username = documentation.match(/^\s*-\s*用户名：`([^\r\n`]+)`\s*$/m)?.[1];
      const password = documentation.match(/^\s*-\s*密码：`([^\r\n`]+)`\s*$/m)?.[1];
      if (!username || !password) {
        err('Admin access documentation is missing or incomplete.');
        return 1;
      }
      const login = await fetchImpl(`${ORIGIN}/api/admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ username, password }),
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      const cookie = login.headers?.get?.('set-cookie')?.match(/(?:^|,\s*)admin_session=([^;,\s]+)/)?.[1];
      if (!login.ok || !cookie) {
        out(JSON.stringify({ ok: false, code: 'admin_login_failed', httpStatus: login.status }));
        return 1;
      }
      const headers = { cookie: `admin_session=${cookie}`, accept: 'application/json' };
      const sourceResponse = await fetchImpl(`${ORIGIN}/api/admin/sources`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      const sourceBody = await sourceResponse.json();
      const sources = Array.isArray(sourceBody.sources)
        ? sourceBody.sources.filter((source) => source && typeof source.gitUrl === 'string'
          && SOURCE.test(source.gitUrl.trim()) && source.branch === 'main')
        : [];
      if (!sourceResponse.ok || sources.length !== 1 || typeof sources[0].id !== 'string'
          || !/^[A-Za-z0-9_-]{1,128}$/.test(sources[0].id)) {
        out(JSON.stringify({ ok: false, code: 'github_source_not_unique_or_unavailable' }));
        return 1;
      }
      submitted = true;
      const response = await fetchImpl(`${ORIGIN}/api/admin/sync/${encodeURIComponent(sources[0].id)}`, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(300_000),
      });
      let result;
      try { result = await response.json(); } catch { result = {}; }
      if (!response.ok || !Number.isSafeInteger(result.synced) || !Array.isArray(result.errors) || result.errors.length) {
        const code = response.status === 409 ? 'sync_busy'
          : response.ok && Array.isArray(result.errors) && result.errors.length ? 'partial_failure' : 'sync_failed';
        out(JSON.stringify({ ok: false, httpStatus: response.status, code,
          synced: Number.isSafeInteger(result.synced) ? result.synced : null,
          errorCount: Array.isArray(result.errors) ? result.errors.length : null }));
        return 1;
      }
      out(JSON.stringify({ ok: true, synced: result.synced }));
      return 0;
    }
    const token = env.EASYCODE_MARKET_AUTOMATION_TOKEN;
    if (!token) {
      err('Automation credential is not configured. Set EASYCODE_MARKET_AUTOMATION_TOKEN securely; do not paste it into chat.');
      return 2;
    }
    const endpoint = command === 'status' ? '/api/automation/status' : `/api/automation/sources/${encodeURIComponent(arg)}/sync`;
    submitted = command === 'sync';
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
    err(submitted
      ? 'Sync result is unknown: the request timed out or failed. Check status and server logs before trying again.'
      : 'Unable to complete the read-only check. Check the path and network connection.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
