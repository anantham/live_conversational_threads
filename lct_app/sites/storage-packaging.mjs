import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_MANIFEST_BYTES = 4096;
const MAX_JOURNAL_BYTES = 65536;
const MAX_SQL_BYTES = 65536;
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_MIGRATIONS = 64;

function regularFile(root, name, maximum) {
  const path = join(root, ...name.split('/'));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) {
    throw new Error(`Invalid Site storage metadata file: ${name}`);
  }
  return readFileSync(path, 'utf8');
}

function directory(root, name) {
  const stat = lstatSync(join(root, ...name.split('/')));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid Site storage metadata directory: ${name}`);
}

// Shared by source export and artifact build so neither can silently package extra state.
export function storageMetadataFiles(root) {
  directory(root, '.openai');
  const manifest = JSON.parse(regularFile(root, '.openai/hosting.json', MAX_MANIFEST_BYTES));
  if (Object.keys(manifest).sort().join(',') !== 'd1,project_id,r2' ||
      typeof manifest.project_id !== 'string' || !manifest.project_id.trim() || manifest.d1 !== 'DB' || manifest.r2 !== 'BUCKET') {
    throw new Error('Site hosting manifest must contain only project_id, d1=DB, and r2=BUCKET.');
  }

  directory(root, 'drizzle');
  directory(root, 'drizzle/meta');
  const journal = JSON.parse(regularFile(root, 'drizzle/meta/_journal.json', MAX_JOURNAL_BYTES));
  if (journal.version !== '7' || journal.dialect !== 'sqlite' || !Array.isArray(journal.entries) ||
      journal.entries.length < 1 || journal.entries.length > MAX_MIGRATIONS) {
    throw new Error('Invalid Site Drizzle migration journal.');
  }
  const sql = [];
  const snapshots = [];
  for (const [index, entry] of journal.entries.entries()) {
    const sequence = String(index).padStart(4, '0');
    if (entry.idx !== index || entry.version !== '6' || entry.breakpoints !== true ||
        !Number.isSafeInteger(entry.when) || !new RegExp(`^${sequence}_[a-z0-9_]+$`).test(entry.tag)) {
      throw new Error('Invalid Site Drizzle migration journal entry.');
    }
    const sqlName = `drizzle/${entry.tag}.sql`;
    const snapshotName = `drizzle/meta/${sequence}_snapshot.json`;
    regularFile(root, sqlName, MAX_SQL_BYTES);
    const snapshot = JSON.parse(regularFile(root, snapshotName, MAX_SNAPSHOT_BYTES));
    if (snapshot.dialect !== 'sqlite' || !snapshot.tables || typeof snapshot.tables !== 'object') {
      throw new Error(`Invalid Site Drizzle snapshot: ${snapshotName}`);
    }
    sql.push(sqlName);
    snapshots.push(snapshotName);
  }
  const expectedRoot = [...sql.map((name) => name.slice('drizzle/'.length)), 'meta'].sort();
  const expectedMeta = ['_journal.json', ...snapshots.map((name) => name.slice('drizzle/meta/'.length))].sort();
  if (readdirSync(join(root, 'drizzle')).sort().join('\n') !== expectedRoot.join('\n') ||
      readdirSync(join(root, 'drizzle/meta')).sort().join('\n') !== expectedMeta.join('\n')) {
    throw new Error('Unexpected Site Drizzle migration metadata file.');
  }
  return ['.openai/hosting.json', ...sql, 'drizzle/meta/_journal.json', ...snapshots];
}

export async function copySiteStorageMetadata(root, dist) {
  const files = storageMetadataFiles(root);
  const allowed = new Set(files.map((name) => name === '.openai/hosting.json' ? 'hosting.json' : name));
  const output = join(dist, '.openai');
  if (existsSync(output)) {
    const walk = (directory, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error(`Unexpected Site build metadata path: ${name}`);
        if (entry.isDirectory()) {
          if (name !== 'drizzle' && name !== 'drizzle/meta') throw new Error(`Unexpected Site build metadata path: ${name}`);
          walk(join(directory, entry.name), name);
        } else if (!entry.isFile() || !allowed.has(name)) {
          throw new Error(`Unexpected Site build metadata path: ${name}`);
        }
      }
    };
    if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) {
      throw new Error('Unexpected Site build metadata directory.');
    }
    walk(output);
  }
  for (const filename of files) {
    const destination = join(dist, '.openai', filename === '.openai/hosting.json' ? 'hosting.json' : filename);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, filename), destination);
  }
}
