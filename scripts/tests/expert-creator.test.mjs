import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../../skills/expert-creator/scripts/create-expert.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'easycode-expert-creator-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function create(root, draft) {
  const input = path.join(root, 'draft.json');
  await writeFile(input, JSON.stringify(draft), 'utf8');
  const out = await execFileAsync(process.execPath, [script, '--input', input, '--root', path.join(root, 'experts')]);
  return JSON.parse(out.stdout);
}

test('creates a general expert with installed skills in the real desktop profile format', async (t) => {
  const root = await fixture(t);
  const result = await create(root, {
    name: '会议纪要专家', description: '整理纪要与待办',
    instructions: '梳理议题、决定、负责人和截止日期。', promptProfile: 'general', skills: ['internal-comms'],
  });
  assert.match(result.id, /^expert-[0-9a-f-]{36}$/);
  const filename = path.join(root, 'experts', `${result.id}.json`);
  const profile = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(profile.name, '会议纪要专家');
  assert.equal(profile.version, 1);
  assert.equal(profile.promptProfile, 'general');
  assert.deepEqual(profile.skills, ['internal-comms']);
  assert.equal('allowedTools' in profile, false);
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(path.dirname(filename))).sort(), [`${result.id}.json`]);
});

test('preserves coding mode, explicit tool restrictions and an empty allowlist', async (t) => {
  const root = await fixture(t);
  const result = await create(root, {
    name: '只读代码审查专家', instructions: '只读检查代码并指出问题。', skills: [],
    promptProfile: 'coding', allowedTools: ['read_file', 'glob', 'read_file'], memoryEnabled: false,
  });
  const profile = JSON.parse(await readFile(path.join(root, 'experts', `${result.id}.json`), 'utf8'));
  assert.equal(profile.promptProfile, 'coding');
  assert.deepEqual(profile.allowedTools, ['read_file', 'glob']);
  assert.equal('memoryEnabled' in profile, false);
  const empty = await create(root, { name: '无工具专家', instructions: '只回答。', skills: [], allowedTools: [] });
  const noTools = JSON.parse(await readFile(path.join(root, 'experts', `${empty.id}.json`), 'utf8'));
  assert.deepEqual(noTools.allowedTools, []);
  assert.equal(noTools.promptProfile, 'general');
  assert.notEqual(result.id, empty.id);
});

test('rejects incomplete or malformed drafts without creating an expert file', async (t) => {
  const root = await fixture(t);
  const badDrafts = [
    { name: '', instructions: 'help' },
    { name: '专家', instructions: '' },
    { name: '专家', instructions: 'help', skills: ['a', 3] },
    { name: '专家', instructions: 'help', allowedTools: 'all' },
    { name: '专家', instructions: 'help', promptProfile: 'unknown' },
    { name: '专家', instructions: 'help', promptProfile: null },
    { name: '专家', instructions: 'help', memoryEnabled: 'true' },
  ];
  for (const draft of badDrafts) {
    await assert.rejects(create(root, draft), (error) => /Invalid expert/.test(error.stderr));
  }
  const entries = await readdir(path.join(root, 'experts')).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  assert.deepEqual(entries, []);
});

test('runs when the skill path contains spaces and non-ASCII characters', async (t) => {
  const root = await fixture(t);
  const skillDir = path.join(root, '专家 创建');
  await mkdir(skillDir);
  const copiedScript = path.join(skillDir, 'create-expert.mjs');
  await copyFile(script, copiedScript);
  const input = path.join(root, 'draft.json');
  await writeFile(input, JSON.stringify({ name: '会议纪要专家', instructions: '整理纪要。' }));
  const { stdout } = await execFileAsync(process.execPath, [copiedScript, '--input', input, '--root', path.join(root, 'experts')]);
  const result = JSON.parse(stdout);
  assert.equal(result.name, '会议纪要专家');
  assert.equal(JSON.parse(await readFile(result.path, 'utf8')).name, result.name);
});

test('does not accept a caller-provided id or version', async (t) => {
  const root = await fixture(t);
  const result = await create(root, {
    id: '../other', version: 99, name: '专家', instructions: 'help', skills: [],
  });
  const profile = JSON.parse(await readFile(path.join(root, 'experts', `${result.id}.json`), 'utf8'));
  assert.match(profile.id, /^expert-[0-9a-f-]{36}$/);
  assert.equal(profile.version, 1);
});
