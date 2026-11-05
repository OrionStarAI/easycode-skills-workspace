import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildExpertCatalog, updateExpertCatalog } from './build_expert_catalog.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'expert-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['catalog', 'experts/curator', 'skills/helper']) await mkdir(path.join(root, dir), { recursive: true });
  const manifest = {
    schemaVersion: 1, id: 'curator', version: '1.0.0', category: 'technology', icon: 'tasks',
    name: { zh: '专家', en: 'Curator' }, description: { zh: '描述', en: 'Description' },
    skills: ['helper'], tags: [],
  };
  await writeFile(path.join(root, 'experts/curator/expert.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'experts/curator/EXPERT.md'), '中文职责');
  await writeFile(path.join(root, 'experts/curator/EXPERT.en.md'), 'English role');
  await writeFile(path.join(root, 'skills/helper/SKILL.md'), 'skill');
  await writeFile(path.join(root, 'catalog/expert-templates.json'), JSON.stringify({ items: [{ id: 'old' }] }));
  return root;
}

test('generates a versioned expert entry and skill dependencies while keeping legacy entries', async (t) => {
  const root = await fixture(t);
  const result = await buildExpertCatalog(root);
  assert.equal(result.items[0].id, 'old');
  assert.deepEqual(result.items[1].skills, ['helper']);
  assert.equal(result.items[1].packageVersion, '1.0.0');
  assert.equal(result.items[1].instructions.zh, '中文职责');
  await updateExpertCatalog(root);
  assert.equal(await updateExpertCatalog(root, true), true);
  await writeFile(path.join(root, 'experts/curator/EXPERT.md'), '新的职责');
  assert.equal(await updateExpertCatalog(root, true), false);
  await updateExpertCatalog(root);
  const saved = JSON.parse(await readFile(path.join(root, 'catalog/expert-templates.json'), 'utf8'));
  assert.equal(saved.items[1].instructions.zh, '新的职责');
});

test('rejects a missing dependency and an unmanaged entry with the same id', async (t) => {
  const root = await fixture(t);
  await rm(path.join(root, 'skills/helper/SKILL.md'));
  await assert.rejects(buildExpertCatalog(root));
  await writeFile(path.join(root, 'skills/helper/SKILL.md'), 'skill');
  await writeFile(path.join(root, 'catalog/expert-templates.json'), JSON.stringify({ items: [{ id: 'curator' }] }));
  await assert.rejects(buildExpertCatalog(root), /collides/);
});
