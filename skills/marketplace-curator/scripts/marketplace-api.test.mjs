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

test('admin sync logs in from the backend documentation and syncs only the GitHub main source', async () => {
  const password = 'example-password-only';
  const session = 'example-session-only';
  const calls = [];
  const output = [];
  const options = {
    env: {},
    readFile: async (name) => {
      assert.match(name, /easycodeskills\/docs\/ADMIN_ACCESS\.md$/);
      return `- 用户名：\`example-user\`\n- 密码：\`${password}\`\n`;
    },
    fetchImpl: async (url, config) => {
      calls.push({ url, config });
      if (url.endsWith('/api/admin/auth/login')) {
        return { ...response(200, { ok: true }), headers: { get: () => `admin_session=${session}; Path=/; HttpOnly; Secure` } };
      }
      if (url.endsWith('/api/admin/sources')) return response(200, { sources: [
        { id: 'easycode', gitUrl: 'https://github.com/OrionStarAI/easycode-skills-workspace', branch: 'main' },
        { id: 'other', gitUrl: 'https://github.com/other/repo', branch: 'main' },
      ] });
      return response(200, { synced: 37, errors: [] });
    },
    out: (s) => output.push(s), err: (s) => output.push(s),
  };
  assert.equal(await run(['admin-sync', '/workspace/easycodeskills'], options), 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://skills.deepvlab.ai/api/admin/auth/login');
  assert.equal(calls[1].url, 'https://skills.deepvlab.ai/api/admin/sources');
  assert.equal(calls[2].url, 'https://skills.deepvlab.ai/api/admin/sync/easycode');
  assert.equal(calls[2].config.method, 'POST');
  assert.equal(calls[2].config.headers.cookie, `admin_session=${session}`);
  assert.ok(calls.every(({ config }) => config.redirect === 'error'));
  assert.ok(!output.join('').includes(password));
  assert.ok(!output.join('').includes(session));
  assert.match(output.join(''), /37/);
});

test('admin sync stops before publishing if login or the source is invalid or ambiguous', async () => {
  const docs = '- 用户名：`example-user`\n- 密码：`example-password`\n';
  for (const sources of [
    [],
    [{ id: 'source', gitUrl: 'https://github.com/OrionStarAI/easycode-skills-workspace', branch: 'other' }],
    [{ id: 'one', gitUrl: 'https://github.com/OrionStarAI/easycode-skills-workspace', branch: 'main' },
      { id: 'two', gitUrl: 'https://github.com/OrionStarAI/easycode-skills-workspace.git', branch: 'main' }],
    [{ id: '../escape', gitUrl: 'https://github.com/OrionStarAI/easycode-skills-workspace', branch: 'main' }],
  ]) {
    let syncCalls = 0;
    const code = await run(['admin-sync', '/workspace/easycodeskills'], {
      env: {}, readFile: async () => docs, out: () => {}, err: () => {},
      fetchImpl: async (url) => {
        if (url.endsWith('/login')) return { ...response(200, { ok: true }), headers: { get: () => 'admin_session=test; Path=/' } };
        if (url.endsWith('/sources')) return response(200, { sources });
        syncCalls++;
        return response(200, { synced: 1, errors: [] });
      },
    });
    assert.equal(code, 1);
    assert.equal(syncCalls, 0);
  }
  let syncCalls = 0;
  const code = await run(['admin-sync', '/workspace/easycodeskills'], {
    env: {}, readFile: async () => docs, out: () => {}, err: () => {},
    fetchImpl: async () => { syncCalls++; return response(401, { error: 'Invalid username or password' }); },
  });
  assert.equal(code, 1);
  assert.equal(syncCalls, 1);
});

test('admin sync reports busy and partial failure accurately without exposing errors or retrying', async () => {
  for (const [status, body, expected] of [
    [409, { error: 'private details' }, 'sync_busy'],
    [200, { synced: 1, errors: ['private details'] }, 'partial_failure'],
    [500, { error: 'private details' }, 'sync_failed'],
  ]) {
    let syncCalls = 0;
    const output = [];
    const code = await run(['admin-sync', '/workspace/easycodeskills'], {
      env: {}, readFile: async () => '- 用户名：`u`\n- 密码：`p`\n',
      out: (s) => output.push(s), err: (s) => output.push(s),
      fetchImpl: async (url) => {
        if (url.endsWith('/login')) return { ...response(200, { ok: true }), headers: { get: () => 'admin_session=test; Path=/' } };
        if (url.endsWith('/sources')) return response(200, { sources: [
          { id: 'easycode', gitUrl: 'https://github.com/OrionStarAI/easycode-skills-workspace', branch: 'main' },
        ] });
        syncCalls++;
        return response(status, body);
      },
    });
    assert.equal(code, 1);
    assert.equal(syncCalls, 1);
    assert.match(output.join(''), new RegExp(expected));
    assert.ok(!output.join('').includes('private details'));
  }
});

test('admin sync does not pretend to succeed on missing credentials or an interrupted request', async () => {
  const output = [];
  let syncCalls = 0;
  const inaccessible = await run(['admin-sync', '/workspace/easycodeskills'], {
    env: {}, readFile: async () => { throw new Error('private path'); },
    out: (s) => output.push(s), err: (s) => output.push(s),
    fetchImpl: async () => { syncCalls++; },
  });
  assert.equal(inaccessible, 1);
  assert.match(output.join(''), /documentation/i);
  assert.ok(!output.join('').includes('private path'));
  const missing = await run(['admin-sync', '/workspace/easycodeskills'], {
    env: {}, readFile: async () => '', out: (s) => output.push(s), err: (s) => output.push(s),
    fetchImpl: async () => { syncCalls++; },
  });
  assert.equal(missing, 1);
  assert.equal(syncCalls, 0);
  const interrupted = await run(['admin-sync', '/workspace/easycodeskills'], {
    env: {}, readFile: async () => '- 用户名：`u`\n- 密码：`p`\n',
    out: (s) => output.push(s), err: (s) => output.push(s),
    fetchImpl: async (url) => {
      if (url.endsWith('/login')) return { ...response(200, { ok: true }), headers: { get: () => 'admin_session=test; Path=/' } };
      if (url.endsWith('/sources')) return response(200, { sources: [
        { id: 'easycode', gitUrl: 'https://github.com/OrionStarAI/easycode-skills-workspace', branch: 'main' },
      ] });
      syncCalls++;
      throw new Error('private failure');
    },
  });
  assert.equal(interrupted, 1);
  assert.equal(syncCalls, 1);
  assert.match(output.join(''), /unknown/i);
  assert.ok(!output.join('').includes('private failure'));
});
