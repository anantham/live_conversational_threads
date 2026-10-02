const normalize = (text) => String(text || '').normalize('NFKC').toLocaleLowerCase();

// Every word is indexed. Chunk offsets refer to the original source string, so
// opening a search hit never has to reconstruct or normalize the transcript.
export function buildConversationSearchDocuments(nodes = [], utterances = [], fullTranscript = '') {
  const documents = [];
  const add = (item, text) => {
    const source = String(text || '');
    const words = [...source.matchAll(/\S+/g)];
    for (let offset = 0; offset < words.length; offset += 64) {
      const last = words[Math.min(offset + 80, words.length) - 1];
      const start = words[offset].index;
      const end = last.index + last[0].length;
      documents.push({ ...item, id: `${item.key}:${offset}`, text: source.slice(start, end), start, end });
      if (offset + 80 >= words.length) break;
    }
  };
  nodes.forEach(node => add({ key: `node:${node.id}`, kind: 'node', nodeId: String(node.id),
    title: node.node_name || node.title || 'Untitled branch' },
  [node.node_name || node.title, node.summary, node.source_excerpt].filter(Boolean).join('\n')));
  utterances.forEach(row => add({ key: `utterance:${row.id}`, kind: 'utterance', utteranceId: String(row.id),
    seconds: row.timestamp_start, title: row.speaker_name || row.speaker_display || row.speaker_id || 'Source passage' }, row.text));
  add({ key: 'transcript', kind: 'transcript', title: 'Original transcript' }, fullTranscript);
  return documents;
}

export function searchConversationText(documents, query, limit = 12) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const phrase = normalize(query).trim();
  const matches = documents.map(item => {
    const text = normalize(`${item.title} ${item.text}`);
    const hits = terms.filter(term => text.includes(term)).length;
    return { ...item, score: hits / terms.length + (text.includes(phrase) ? 1 : 0) };
  }).filter(item => item.score >= 1).sort((a, b) => b.score - a.score);
  return uniqueSearchResults(matches, limit);
}

export function uniqueSearchResults(results, limit = 12) {
  const seen = new Set();
  return results.filter(item => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  }).slice(0, limit);
}

export function rankConversationVectors(documents, vectors, queryVector, limit = 12) {
  const scored = documents.map((item, index) => ({ ...item,
    score: vectors[index].reduce((sum, value, dimension) => sum + value * queryVector[dimension], 0) }));
  return uniqueSearchResults(scored.filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score), limit);
}
