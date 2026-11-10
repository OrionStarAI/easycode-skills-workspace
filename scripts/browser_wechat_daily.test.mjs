import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const template = await readFile(new URL('../skills/wechat-official-account/scripts/browser_account_daily.js', import.meta.url), 'utf8');
const token = 'synthetic-session-token';
const stamp = (day) => Date.parse(`${day}T00:00:00+08:00`) / 1000;
const sample = {
  base_resp: { ret: 0 },
  user_info: { token },
  all_article_stat_tendency: { list: [
    { date: stamp('2025-11-01'), scene: 9999, read_uv: 8, share_uv: 0, collection_uv: 1 },
    { date: stamp('2025-11-01'), scene: 6, read_uv: 7 },
    { date: stamp('2025-11-02'), scene: 9999, read_uv: 12, share_uv: 2, collection_uv: 0 },
  ] },
  all_article_stat_source: { list: [{ scene: 6, read_uv: 18 }] },
};

async function run({ start = '2025-11-01', end = '2025-11-03', data = sample,
  origin = 'https://mp.weixin.qq.com', request = null } = {}) {
  const script = template.replace('__START_DATE__', start).replace('__END_DATE__', end);
  const calls = [];
  const context = {
    URL, Date, Math, Number, Map,
    location: { origin },
    document: { querySelectorAll: () => [{ textContent: '下载数据明细',
      href: `https://mp.weixin.qq.com/misc/appmsganalysis?action=download_summary_tendency&token=${token}` }] },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      if (request) return request();
      return { ok: true, json: async () => data };
    },
  };
  const result = await vm.runInNewContext(script, context);
  return { result: JSON.parse(JSON.stringify(result)), calls };
}

test('uses the signed-in content page, maps daily account readers, and hides session data', async () => {
  const { result, calls } = await run();
  assert.equal(result.success, true);
  assert.equal(result.scope, 'account');
  assert.deepEqual(result.daily.map((d) => d.readUsers), [8, 12, null]);
  assert.equal(result.daily[1].changeFromPreviousDay, 4);
  assert.equal(result.daily[1].changeRateFromPreviousDay, 50);
  assert.equal(result.daily[2].changeFromPreviousDay, null);
  assert.deepEqual(result.sources, [{ scene: 6, name: '推荐', readUsers: 18 }]);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://mp.weixin.qq.com');
  assert.equal(url.searchParams.get('action'), 'get_article_stat_tendency_and_source');
  assert.equal(Number(url.searchParams.get('begin_timestamp')), stamp('2025-11-01'));
  assert.equal(Number(url.searchParams.get('end_timestamp')), stamp('2025-11-03') + 86399);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('rejects unsupported date ranges and unrelated sites before sending requests', async () => {
  for (const args of [
    { start: '2025-10-31' }, { start: '2025-11-03', end: '2025-11-01' },
    { start: '2025-11-01', end: '2025-12-02' }, { end: '2099-01-01' },
    { start: '2025-11-31' }, { origin: 'https://example.com' },
  ]) {
    const { result, calls } = await run(args);
    assert.equal(result.success, false);
    assert.equal(calls.length, 0);
  }
});

test('does not infer growth from missing values or divide by a zero baseline', async () => {
  const data = { ...sample, all_article_stat_tendency: { list: [
    { date: stamp('2025-11-01'), scene: 9999, read_uv: 0 },
    { date: stamp('2025-11-02'), scene: 9999, read_uv: 3 },
  ] } };
  const { result } = await run({ data });
  assert.equal(result.daily[1].changeFromPreviousDay, 3);
  assert.equal(result.daily[1].changeRateFromPreviousDay, null);
  assert.equal(result.daily[2].readUsers, null);
  assert.equal(result.daily[2].changeFromPreviousDay, null);
});

test('fails closed for duplicate dates, unrecognized responses, and secret-bearing errors', async () => {
  const duplicate = { ...sample, all_article_stat_tendency: { list: [
    { date: stamp('2025-11-01'), scene: 9999, read_uv: 2 },
    { date: stamp('2025-11-01'), scene: 9999, read_uv: 3 },
  ] } };
  for (const args of [
    { data: duplicate }, { data: { base_resp: { ret: 48001 } } },
    { request: () => { throw new Error(`private ${token}`); } },
  ]) {
    const { result } = await run(args);
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal('daily' in result, false);
  }
});
