import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Execute the actual ego-browser script with its browser and filesystem replaced
// by deterministic fixtures. No account, browser, upload or network is touched.
const script = await readFile(new URL('../skills/douyin-publish/scripts/douyin_publish.js', import.meta.url), 'utf8');
assert.ok(script.includes("const fs = await import('fs')"));
assert.ok(script.includes('const argv = process.argv.slice(2)'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runScript = new AsyncFunction(
  'fakeFs', 'fakeProcess', 'cliLog', 'cdp', 'js', 'wait', 'gotoAndWait', 'waitForLoad',
  'useOrCreateTaskSpace', 'listTaskSpaces', 'takeOverTaskSpace', 'claimTaskSpace',
  script.replace("const fs = await import('fs')", 'const fs = fakeFs')
    .replace('const argv = process.argv.slice(2)', 'const argv = fakeProcess.argv.slice(2)')
    .replaceAll('process.exit(', 'fakeProcess.exit('),
);

class Exit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

async function simulate(options = {}) {
  const params = options.params ?? { video: '/tmp/example.mp4', title: '测试标题', desc: '测试说明', tags: ['科普'] };
  const inputTags = Array.isArray(params.tags) ? params.tags : [];
  const expectedDesc = [params.desc, ...inputTags.map((t) => t.startsWith('#') ? t : `#${t}`)].filter(Boolean).join(' ');
  const logs = [];
  const stats = { clicks: 0, uploads: 0, spaces: 0, takeovers: 0, claims: 0 };
  const fakeFs = {
    readFileSync: () => JSON.stringify(params),
    existsSync: () => options.videoExists !== false,
    statSync: () => ({ isFile: () => options.regularFile !== false }),
    writeFileSync: () => {},
  };
  const fakeProcess = { argv: ['node', 'script', ...(options.argv ?? [])], exit: (code) => { throw new Exit(code); } };
  const cdp = async (method) => {
    if (method === 'Network.getCookies') return { cookies: options.loggedIn === false ? [] : [{ name: 'sessionid' }] };
    if (method === 'Page.captureScreenshot') return { data: '' };
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: options.fileInput === false ? 0 : 2 };
    if (method === 'DOM.setFileInputFiles') { stats.uploads++; return {}; }
    throw new Error(`unexpected CDP ${method}`);
  };
  const js = async (source) => {
    if (source === 'document.body.innerText.includes("你还有上次未发布的视频")') return options.existingDraft ?? false;
    if (source === "!!document.querySelector('.zone-container.editor-kit-container')") return true;
    if (source.includes('Object.getOwnPropertyDescriptor(window.HTMLInputElement')) return options.titleFill ?? 'ok';
    if (source.includes("document.execCommand('insertText'")) return options.descFill ?? 'ok';
    if (source.includes('title: ([...document.querySelectorAll')) return {
      title: options.returnedTitle ?? params.title,
      desc: options.returnedDesc ?? expectedDesc,
    };
    if (source.includes('const reupload =')) return options.upload ?? { ready: true, failed: false };
    if (source === 'document.body.innerText.includes("检测中")') return options.checking ?? false;
    if (source.includes('publishBtn:')) return { publishBtn: options.button !== false, err: options.errors ?? [] };
    if (source.includes('b.click()')) {
      stats.clicks++;
      if (options.clickThrows) throw new Error('click state unknown');
      return options.clicked !== false;
    }
    if (source === 'location.href') {
      if (options.statusThrows) throw new Error('page disconnected');
      return options.redirect === false ? '/upload' : '/creator-micro/content/manage';
    }
    if (source === 'document.body.innerText.includes("发布成功")') return options.confirmed !== false;
    throw new Error(`unexpected browser expression: ${source.slice(0, 80)}`);
  };
  try {
    await runScript(fakeFs, fakeProcess, (line) => logs.push(line), cdp, js, async () => {},
      async () => {}, async () => {}, async () => { stats.spaces++; if (options.spaceUnavailable) throw new Error('busy'); return { id: 1 }; },
      async () => [], async () => { stats.takeovers++; }, async () => { stats.claims++; });
    return { code: 0, logs, ...stats };
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    return { code: error.code, logs, ...stats };
  }
}

test('invalid parameters fail before opening any task space', async () => {
  for (const params of [
    { video: '/tmp/example.mp4', title: 'x'.repeat(31) },
    { video: '/tmp/example.mp4', title: '标题', tags: 'not-an-array' },
    { video: '', title: '标题' },
    { video: 'relative.mp4', title: '标题' },
  ]) {
    const result = await simulate({ params });
    assert.equal(result.code, 1);
    assert.equal(result.spaces, 0);
    assert.equal(result.clicks, 0);
  }
});

test('rejects a directory in place of a video file', async () => {
  const result = await simulate({ regularFile: false });
  assert.equal(result.code, 1);
  assert.equal(result.spaces, 0);
  assert.equal(result.clicks, 0);
});

test('does not take over or claim a task space when it is unavailable', async () => {
  const result = await simulate({ spaceUnavailable: true });
  assert.equal(result.code, 1);
  assert.equal(result.takeovers, 0);
  assert.equal(result.claims, 0);
  assert.equal(result.uploads, 0);
  assert.ok(result.logs.some((line) => line.includes('TASK_SPACE_UNAVAILABLE')));
});

test('login timeout is reported without uploading or publishing', async () => {
  const result = await simulate({ loggedIn: false });
  assert.equal(result.code, 2);
  assert.equal(result.uploads, 0);
  assert.equal(result.clicks, 0);
});

test('leaves an existing unpublished video untouched', async () => {
  const result = await simulate({ existingDraft: true });
  assert.equal(result.code, 1);
  assert.equal(result.uploads, 0);
  assert.equal(result.clicks, 0);
  assert.ok(result.logs.some((line) => line.includes('EXISTING_DRAFT')));
});

test('refuses an altered title or missing description and tags', async () => {
  for (const options of [{ returnedTitle: '另一个标题' }, { returnedDesc: '测试说明' }]) {
    const result = await simulate(options);
    assert.equal(result.code, 1);
    assert.equal(result.clicks, 0);
    assert.ok(result.logs.some((line) => line.includes('MISMATCH')));
  }
});

test('does not publish a failed or unconfirmed upload', async () => {
  for (const upload of [{ ready: false, failed: true }, { ready: false, failed: false }]) {
    const result = await simulate({ upload });
    assert.equal(result.code, 1);
    assert.equal(result.clicks, 0);
    assert.ok(result.logs.some((line) => line.includes('UPLOAD_')));
  }
});

test('does not publish while content review is pending or form has errors', async () => {
  for (const options of [{ checking: true }, { errors: ['表单错误'] }, { button: false }]) {
    const result = await simulate(options);
    assert.equal(result.code, 1);
    assert.equal(result.clicks, 0);
  }
});

test('dry run uploads to the form but never clicks publish', async () => {
  const result = await simulate({ argv: ['--dry_run'] });
  assert.equal(result.code, 0);
  assert.equal(result.uploads, 1);
  assert.equal(result.clicks, 0);
  assert.ok(result.logs.some((line) => line.includes('DRYRUN_OK')));
});

test('a click exception, missing success signal, or disconnected status has unknown outcome', async () => {
  for (const options of [{ clickThrows: true }, { confirmed: false }, { statusThrows: true }, { redirect: false }]) {
    const result = await simulate(options);
    assert.equal(result.code, 3);
    assert.equal(result.clicks, 1);
    assert.ok(result.logs.some((line) => line.includes('PUBLISH_UNCONFIRMED')));
  }
});

test('reports success only after one click and an explicit success signal', async () => {
  const result = await simulate();
  assert.equal(result.code, 0);
  assert.equal(result.clicks, 1);
  assert.ok(result.logs.some((line) => line.includes('PUBLISH_SUCCESS')));
});

test('shell wrapper passes JSON and dry-run flag to the actual browser script', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'douyin-wrapper-test-'));
  try {
    const paramsFile = path.join(tmp, 'params.json');
    const fixture = { video: '/tmp/example.mp4', title: '测试标题', desc: '文字', tags: ['标签'] };
    await writeFile(paramsFile, JSON.stringify(fixture));
    const fakeBrowser = path.join(tmp, 'ego-browser');
    await writeFile(fakeBrowser, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const source = fs.readFileSync(0, 'utf8');
const match = source.match(/const PARAMS_FILE = '([^']+)'/);
if (!match || !source.includes("const argv = ['--dry_run']")) process.exit(5);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
new AsyncFunction(source); // Verify the generated script parses, but never execute it.
process.stdout.write(fs.readFileSync(match[1], 'utf8'));
`);
    await chmod(fakeBrowser, 0o755);
    const wrapper = fileURLToPath(new URL('../skills/douyin-publish/scripts/douyin_publish.sh', import.meta.url));
    const result = spawnSync('bash', [wrapper, '--params', paramsFile, '--dry-run'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ...fixture, dry_run: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('healthcheck ignores stale or invalid publication parameters', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'douyin-healthcheck-test-'));
  try {
    const stale = path.join(tmp, 'old.json');
    await writeFile(stale, 'not JSON');
    const fakeBrowser = path.join(tmp, 'ego-browser');
    await writeFile(fakeBrowser, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const source = fs.readFileSync(0, 'utf8');
const match = source.match(/const PARAMS_FILE = '([^']+)'/);
if (!match || !source.includes("const argv = ['--healthcheck']")) process.exit(5);
process.stdout.write(fs.readFileSync(match[1], 'utf8'));
`);
    await chmod(fakeBrowser, 0o755);
    const wrapper = fileURLToPath(new URL('../skills/douyin-publish/scripts/douyin_publish.sh', import.meta.url));
    const result = spawnSync('bash', [wrapper, '--params', stale, '--healthcheck'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { healthcheck: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
