import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './marketplace-api.mjs';

const secret = 'test-' + 'x'.repeat(40);
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('status uses the fixed origin, a bearer header, and never prints the credential', async () => {
  const output = [];
  const calls = [];
  const code = await run(['status'], {
    env: { EASYCODE_MARKET_AUTOMATION_TOKEN: secret },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200, { ok: true, scheduler: {}, sources: [] }); },
    out: (s) => output.push(s), err: (s) => output.push(s),
  });
  assert.equal(code, 0);
  assert.equal(calls[0].url, 'https://skills.deepvlab.ai/api/automation/status');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${secret}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(!output.join('').includes(secret));
});

test('busy and partial syncs are not retried or reported as success', async () => {
  for (const [status, body] of [[409, { code: 'sync_busy' }], [502, { code: 'partial_failure', synced: 1, errorCount: 2 }]]) {
    let calls = 0;
    const output = [];
    const code = await run(['sync', 'workspace'], {
      env: { EASYCODE_MARKET_AUTOMATION_TOKEN: secret },
      fetchImpl: async () => { calls++; return response(status, body); },
      out: (s) => output.push(s), err: (s) => output.push(s),
    });
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(output[0]).code, body.code);
  }
});

test('an interrupted sync reports an unknown outcome without a retry', async () => {
  let calls = 0;
  const output = [];
  const code = await run(['sync', 'workspace'], {
    env: { EASYCODE_MARKET_AUTOMATION_TOKEN: secret },
    fetchImpl: async () => { calls++; throw new Error(secret); },
    out: (s) => output.push(s), err: (s) => output.push(s),
  });
  assert.equal(code, 1);
  assert.equal(calls, 1);
  assert.match(output[0], /unknown/);
  assert.ok(!output[0].includes(secret));
});

test('compare detects changes while ignoring object key ordering', async () => {
  const output = [];
  const code = await run(['compare', '/repo'], {
    readFile: async () => JSON.stringify({ items: [{ a: 1, b: 2 }] }),
    fetchImpl: async (url) => response(200, { items: [url.endsWith('mcp-servers') ? { a: 1, b: 3 } : { b: 2, a: 1 }], meta: { source: 'synced' } }),
    out: (s) => output.push(s), err: (s) => output.push(s),
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output[0]).catalogs.map((item) => item.matches), [true, false]);
});

test('rejects missing credentials and arbitrary URL commands without a network request', async () => {
  let calls = 0;
  const opts = { env: {}, fetchImpl: async () => { calls++; }, out: () => {}, err: () => {} };
  assert.equal(await run(['status'], opts), 2);
  assert.equal(await run(['https://example.invalid'], opts), 2);
  assert.equal(calls, 0);
});
