#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this validation aligned with Easy Code's parseExpertProfile. A missing
// allowlist inherits the user's tool policy; an explicit [] permits no tools.
function list(value, label) {
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid expert ${label}`);
  }
  const items = value.map((item) => item.trim());
  if (items.some((item) => !item || item.length > 200 || /[\r\n\0]/.test(item))) {
    throw new Error(`Invalid expert ${label}`);
  }
  return [...new Set(items)];
}

function optionalString(value, name) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
    throw new Error(`Invalid expert ${name}`);
  }
  return value.trim() || undefined;
}

export function expertFromDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('Invalid expert configuration');
  }
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  const description = typeof draft.description === 'string' ? draft.description.trim() : '';
  const instructions = typeof draft.instructions === 'string' ? draft.instructions.trim() : '';
  if (!name || name.length > 100) throw new Error('Invalid expert name');
  if (!instructions || instructions.length > 32000) throw new Error('Invalid expert instructions');
  if (description.length > 2000) throw new Error('Invalid expert description');
  const skills = list(draft.skills ?? [], 'skills');
  const promptProfile = draft.promptProfile === undefined ? 'general' : draft.promptProfile;
  if (promptProfile !== 'general' && promptProfile !== 'coding') {
    throw new Error('Invalid expert prompt profile');
  }
  const allowedTools = draft.allowedTools === undefined ? undefined : list(draft.allowedTools, 'tools');
  const workspace = optionalString(draft.workspace, 'workspace');
  const model = optionalString(draft.model, 'model');
  if (draft.memoryEnabled !== undefined && typeof draft.memoryEnabled !== 'boolean') {
    throw new Error('Invalid expert memory setting');
  }
  return {
    id: `expert-${randomUUID()}`,
    name,
    description,
    instructions,
    skills,
    promptProfile,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(workspace ? { workspace } : {}),
    ...(model ? { model } : {}),
    ...(draft.memoryEnabled === true ? { memoryEnabled: true } : {}),
    version: 1,
  };
}

export async function createExpert(draft, root = path.join(os.homedir(), '.easycode-user', 'experts')) {
  const profile = expertFromDraft(draft);
  if (!path.isAbsolute(root)) throw new Error('Invalid expert directory: expected an absolute path');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, `${profile.id}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { id: profile.id, name: profile.name, path: target };
}

async function main(argv) {
  let input;
  let root;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if ((flag !== '--input' && flag !== '--root') || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Usage: create-expert.mjs --input <draft.json> [--root <absolute test directory>]');
    }
    const value = argv[++index];
    if (flag === '--input' && input === undefined) input = value;
    else if (flag === '--root' && root === undefined) root = value;
    else throw new Error(`Duplicate option: ${flag}`);
  }
  if (!input) throw new Error('Usage: create-expert.mjs --input <draft.json>');
  const draft = JSON.parse(await fs.readFile(input, 'utf8'));
  const result = await createExpert(draft, root);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
