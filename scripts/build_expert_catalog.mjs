#!/usr/bin/env node
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;

async function regularFile(file) {
  if (!(await lstat(file)).isFile()) throw new Error(`Expected a regular file: ${file}`);
  return readFile(file, 'utf8');
}

/** Build the public index from each expert package and preserve legacy entries. */
export async function buildExpertCatalog(root) {
  const catalogFile = path.join(root, 'catalog', 'expert-templates.json');
  const original = JSON.parse(await regularFile(catalogFile));
  if (!Array.isArray(original.items)) throw new Error('Catalog items must be an array');
  const packages = new Map();
  const expertRoot = path.join(root, 'experts');
  for (const entry of (await readdir(expertRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !ID.test(entry.name)) throw new Error(`Invalid expert package: ${entry.name}`);
    const dir = path.join(expertRoot, entry.name);
    const manifest = JSON.parse(await regularFile(path.join(dir, 'expert.json')));
    if (manifest.schemaVersion !== 1 || manifest.id !== entry.name || !VERSION.test(manifest.version)) {
      throw new Error(`Invalid expert manifest: ${entry.name}`);
    }
    if (!Array.isArray(manifest.skills) || manifest.skills.length > 32 || new Set(manifest.skills).size !== manifest.skills.length
        || manifest.skills.some((skill) => typeof skill !== 'string' || !ID.test(skill))) {
      throw new Error(`Invalid skill dependencies: ${entry.name}`);
    }
    for (const skill of manifest.skills) {
      const skillDir = path.join(root, 'skills', skill);
      if (!(await lstat(skillDir)).isDirectory()) throw new Error(`Invalid skill directory: ${skill}`);
      await regularFile(path.join(skillDir, 'SKILL.md'));
    }
    const zh = (await regularFile(path.join(dir, 'EXPERT.md'))).trim();
    const en = (await regularFile(path.join(dir, 'EXPERT.en.md'))).trim();
    if (!zh || !en || zh.length > 32_000 || en.length > 32_000) throw new Error(`Invalid expert instructions: ${entry.name}`);
    packages.set(entry.name, {
      id: manifest.id,
      kind: 'expert',
      category: manifest.category,
      icon: manifest.icon,
      name: manifest.name,
      description: manifest.description,
      instructions: { zh, en },
      skills: manifest.skills,
      packageVersion: manifest.version,
      packageSource: `experts/${entry.name}`,
      tags: manifest.tags,
    });
  }
  const seen = new Set();
  const items = original.items.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || seen.has(item.id)) throw new Error('Invalid or duplicate catalog id');
    seen.add(item.id);
    if (!item.packageSource) {
      if (packages.has(item.id)) throw new Error(`Package collides with an unmanaged catalog item: ${item.id}`);
      return item;
    }
    if (item.packageSource !== `experts/${item.id}` || !packages.has(item.id)) throw new Error(`Missing or invalid package: ${item.id}`);
    const result = packages.get(item.id);
    packages.delete(item.id);
    return result;
  });
  items.push(...packages.values());
  return { ...original, items };
}

export async function updateExpertCatalog(root, check = false) {
  const file = path.join(root, 'catalog', 'expert-templates.json');
  const current = JSON.parse(await regularFile(file));
  const generated = await buildExpertCatalog(root);
  if (check) return JSON.stringify(current) === JSON.stringify(generated);
  await writeFile(file, `${JSON.stringify(generated, null, 2)}\n`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (process.argv.slice(2).some((arg) => arg !== '--check')) {
    console.error('Usage: build_expert_catalog.mjs [--check]');
    process.exitCode = 2;
  } else {
    try {
      const ok = await updateExpertCatalog(root, process.argv.includes('--check'));
      if (!ok) {
        console.error('Expert catalog is out of date; run node scripts/build_expert_catalog.mjs');
        process.exitCode = 1;
      } else console.log('Expert package catalog OK');
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
