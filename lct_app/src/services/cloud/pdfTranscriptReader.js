import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseGeminiNotesDocument, parsePlainTranscriptText } from './geminiNotesParser.js';

function groupItemsIntoLines(items) {
  const rows = [];
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    const text = item.str;
    if (!text && !item.hasEOL) continue;
    const y = Math.round((item.transform?.[5] ?? 0) * 2) / 2;
    const x = item.transform?.[4] ?? 0;
    let row = rows.find(candidate => Math.abs(candidate.y - y) <= 2.5);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, text });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(row => {
    row.parts.sort((a, b) => a.x - b.x);
    return row.parts.map(part => part.text).join('').trim();
  });
}

export async function readTranscriptFile(file) {
  if (!file) throw new Error('Choose a transcript file first.');
  const name = file.name || 'transcript';
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const [content, annotations] = await Promise.all([page.getTextContent(), page.getAnnotations()]);
      const lines = groupItemsIntoLines(content.items || []);
      const links = (annotations || []).map(annotation => annotation?.url).filter(Boolean);
      pages.push({ pageNumber, lines, links });
    }
    return parseGeminiNotesDocument({ filename: name, pages });
  }
  const text = await file.text();
  return parsePlainTranscriptText({ filename: name, text });
}
