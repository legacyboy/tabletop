/**
 * Session persistence for the Tabletop API.
 *
 * Sessions are saved as JSON files under data/sessions/<id>.json so they
 * survive server restarts. Each file holds the serialized session snapshot
 * plus the provider config used to create it (so it can be rebuilt with the
 * same model/endpoint).
 *
 * On server start, call loadAll() to restore every saved session into the
 * in-memory store.
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = join(ROOT, 'data/sessions');

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

/** Save a session (snapshot + provider config) to disk. */
export async function saveSession(id, snapshot, providerConfig) {
  await ensureDir();
  const file = join(DATA_DIR, `${id}.json`);
  await writeFile(file, JSON.stringify({ snapshot, providerConfig }, null, 2), 'utf8');
}

/** Load a single session file. Returns { snapshot, providerConfig } or null. */
export async function loadSession(id) {
  try {
    const raw = await readFile(join(DATA_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Load all saved sessions. Returns a Map of id -> { snapshot, providerConfig }. */
export async function loadAll() {
  const out = new Map();
  try {
    const files = await readdir(DATA_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/, '');
      const data = await loadSession(id);
      if (data) out.set(id, data);
    }
  } catch {
    // data dir doesn't exist yet — no sessions
  }
  return out;
}

/** Delete a saved session file. */
export async function deleteSession(id) {
  try {
    await unlink(join(DATA_DIR, `${id}.json`));
  } catch {
    /* ignore */
  }
}
