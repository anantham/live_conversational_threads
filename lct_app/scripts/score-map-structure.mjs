#!/usr/bin/env node
/**
 * Print structural counts for saved `.threads` maps (src/services/cloud/mapStructure.js).
 *
 *   node scripts/score-map-structure.mjs <map.threads>... [--json]
 *
 * Counts, not a quality score: read a map against its transcript before trusting them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mapStructure } from '../src/services/cloud/mapStructure.js';

const args = process.argv.slice(2), json = args.includes('--json'), files = args.filter(arg => arg !== '--json');
if (!files.length) { console.error('Usage: node scripts/score-map-structure.mjs <map.threads>... [--json]'); process.exit(2); }

const rows = files.map(file => {
  try { return { file, ...mapStructure(JSON.parse(readFileSync(file, 'utf8'))) }; }
  catch (error) { console.error(`${file}: ${error.message}`); process.exitCode = 1; return null; }
}).filter(Boolean);

if (json) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(['map', 'turns', 'nodes L1-L5', 'chunks', 'multi-turn', 'backchannel', 'largest words',
    'single-child/parents', 'childless above chunks', 'mismatches L1-L4'].join(' | '));
  for (const r of rows) console.log([path.basename(r.file), r.utterances, r.nodesByLevel.join('/'), r.chunks,
    r.multiUtteranceChunks, r.backchannelChunks, r.largestChunkWords, `${r.singleChildParents}/${r.parents}`,
    r.childlessHigherNodes, r.mismatchesByChildLevel.join('/')].join(' | '));
}
