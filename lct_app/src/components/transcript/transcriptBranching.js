const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "been",
  "being",
  "could",
  "from",
  "have",
  "into",
  "just",
  "like",
  "more",
  "need",
  "really",
  "should",
  "that",
  "their",
  "there",
  "thing",
  "this",
  "with",
  "would",
  "yeah",
  "you",
  "your",
]);

const BRANCH_PALETTE_SIZE = 7;

function normalizeTerm(term) {
  const cleaned = String(term || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length <= 2 || STOP_WORDS.has(cleaned)) return "";
  if (cleaned.endsWith("ing") && cleaned.length > 6) return cleaned.slice(0, -3);
  if (cleaned.endsWith("ed") && cleaned.length > 5) return cleaned.slice(0, -2);
  if (cleaned.endsWith("s") && cleaned.length > 4) return cleaned.slice(0, -1);
  return cleaned;
}

function extractTerms(text) {
  const counts = new Map();
  String(text || "")
    .split(/\s+/)
    .map(normalizeTerm)
    .filter(Boolean)
    .forEach((term) => counts.set(term, (counts.get(term) || 0) + 1));

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term);
}

function overlapScore(aTerms, bTerms) {
  if (!aTerms.length || !bTerms.length) return 0;
  const bSet = new Set(bTerms);
  const overlap = aTerms.filter((term) => bSet.has(term)).length;
  return overlap / Math.min(aTerms.length, bTerms.length);
}

function makeTitle(terms, fallback) {
  const title = terms.slice(0, 3).join(" / ");
  if (title) return title;
  return String(fallback || "live thread").slice(0, 32);
}

function makePreview(lines, maxChars) {
  const text = lines
    .map((line) => String(line.text || "").trim())
    .filter(Boolean)
    .join(" ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}...`;
}

function updateBranch(branch, line, terms, maxPreviewChars) {
  const termCounts = new Map(branch.terms.map((term) => [term, 1]));
  terms.forEach((term) => termCounts.set(term, (termCounts.get(term) || 0) + 1));
  const rankedTerms = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term)
    .slice(0, 10);
  const speaker = line.speaker || "Unknown";
  const speakers = branch.speakers.includes(speaker)
    ? branch.speakers
    : [...branch.speakers, speaker];
  const lines = [...branch.lines, line];

  return {
    ...branch,
    terms: rankedTerms,
    title: makeTitle(rankedTerms, line.text),
    speakers,
    lines,
    lineCount: lines.length,
    preview: makePreview(lines, maxPreviewChars),
    latestText: String(line.text || ""),
    hasDraft: branch.hasDraft || line.isFinal === false,
  };
}

export function buildTranscriptBranches(
  segments,
  {
    maxBranches = 7,
    maxPreviewChars = 150,
    tangentThreshold = 0.16,
    returnThreshold = 0.34,
  } = {}
) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const branches = [];
  let activeBranchId = null;

  segments.forEach((segment, index) => {
    const text = String(segment?.text || "").trim();
    if (!text) return;

    const terms = extractTerms(text);
    const activeBranch = branches.find((branch) => branch.id === activeBranchId) || null;
    const activeScore = activeBranch ? overlapScore(terms, activeBranch.terms) : 0;
    const bestBranch = branches.reduce(
      (best, branch) => {
        const score = overlapScore(terms, branch.terms);
        return score > best.score ? { branch, score } : best;
      },
      { branch: null, score: 0 }
    );

    let target = activeBranch || bestBranch.branch;
    const canShard =
      segment.isFinal !== false &&
      terms.length >= 3 &&
      branches.length < maxBranches &&
      (!activeBranch || (activeScore < tangentThreshold && bestBranch.score < returnThreshold));

    if (!target || canShard) {
      target = {
        id: `branch-${branches.length + 1}`,
        colorIndex: branches.length % BRANCH_PALETTE_SIZE,
        title: makeTitle(terms, text),
        terms: terms.slice(0, 10),
        speakers: [],
        lines: [],
        lineCount: 0,
        preview: "",
        latestText: "",
        hasDraft: false,
        startedAtIndex: index,
      };
      branches.push(target);
    } else if (bestBranch.branch && bestBranch.score >= returnThreshold) {
      target = bestBranch.branch;
    }

    const updated = updateBranch(target, segment, terms, maxPreviewChars);
    const branchIndex = branches.findIndex((branch) => branch.id === updated.id);
    branches[branchIndex] = updated;
    activeBranchId = updated.id;
  });

  return branches.map((branch) => ({
    id: branch.id,
    colorIndex: branch.colorIndex,
    title: branch.title,
    speakers: branch.speakers,
    lineCount: branch.lineCount,
    preview: branch.preview,
    latestText: branch.latestText,
    hasDraft: branch.hasDraft,
    startedAtIndex: branch.startedAtIndex,
  }));
}
