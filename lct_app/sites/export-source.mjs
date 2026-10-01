import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageMetadataFiles } from './storage-packaging.mjs';

const requiredFiles = [
  'index.html', 'package-lock.json', 'public/favicon.svg',
  'api/proxy/_shared.js', 'api/proxy/chat.js', 'api/proxy/realtime-token.js',
  'sites/worker.js', 'sites/vite.config.mjs', 'sites/frontend.config.mjs', 'sites/build.mjs',
  'sites/storage-packaging.mjs', 'sites/storage.js', 'sites/storagePolicy.js', 'sites/storageRecovery.js',
  'sites/publicThreads.js', 'sites/publicThreadsPolicy.js',
  'db/schema.ts', 'drizzle.config.ts',
];

// Public build tool: export only the technical source needed by the Site.
// Excludes local state, credentials, operational history and static recordings.
export function exportSiteSource(sourceRoot, destination) {
  const source = resolve(sourceRoot);
  const output = resolve(destination);
  const inside = relative(source, output);
  if (!inside || (!inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside))) {
    throw new Error('Export destination must be outside the frontend source directory.');
  }
  if (existsSync(output) && (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink() || readdirSync(output).length)) {
    throw new Error('Export destination must be empty; existing files were not changed.');
  }
  const files = [...requiredFiles, ...storageMetadataFiles(source)];
  function collect(directory, prefix = 'src') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Site source cannot contain symlinks: ' + name);
      if (entry.isDirectory()) {
        if (!['__tests__', 'fixtures', '__fixtures__'].includes(entry.name)) collect(join(directory, entry.name), name);
      } else if (entry.isFile() && !/\.(test|spec)\./.test(entry.name) &&
        (/\.(js|jsx|css|svg)$/.test(entry.name) || name === 'src/services/serverless/prompts.json')) {
        files.push(name);
      }
    }
  }
  collect(join(source, 'src'));
  // Validate every source path before creating the output or copying anything.
  for (const filename of [...files, 'package.json']) {
    const segments = filename.split('/');
    for (let count = 1; count <= segments.length; count += 1) {
      const stat = lstatSync(join(source, ...segments.slice(0, count)));
      if (stat.isSymbolicLink()) throw new Error('Site source cannot contain symlinks: ' + filename);
      if (count === segments.length && !stat.isFile()) throw new Error('Site source must be a regular file: ' + filename);
    }
  }
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  manifest.scripts = { build: 'node sites/build.mjs' };
  mkdirSync(output, { recursive: true });
  for (const filename of files) {
    const target = join(output, filename);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, filename), target);
  }
  writeFileSync(join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(output, '.gitignore'), 'node_modules/\ndist/\n.sites-runtime/\n.env*\n*.log\n');
  return { directory: output, fileCount: files.length + 2 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || !isAbsolute(destination) || extra.length) throw new Error('Usage: node sites/export-source.mjs ABSOLUTE_EMPTY_DIRECTORY');
  console.log(JSON.stringify(exportSiteSource(fileURLToPath(new URL('../', import.meta.url)), destination)));
}
