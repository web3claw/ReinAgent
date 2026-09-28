// LiveAgent 移植：crates/agent-ui/src/lib/shared/fuzzySearch.ts
export type SearchHighlightRange = {
  start: number;
  end: number;
};

type RankedItem<T> = {
  item: T;
  index: number;
  score: number | null;
};

const QUERY_SEPARATOR = /[\s,，、;；|]+/u;
const COMPACT_SEPARATOR = /[\s\-_.:/\\]+/gu;
const WORD_PATTERN = /[\p{L}\p{N}+#@._-]+/gu;

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

export function tokenizeSearchQuery(query: string): string[] {
  return Array.from(new Set(normalizeSearchText(query).split(QUERY_SEPARATOR).filter(Boolean)));
}

function boundedEditDistance(left: string, right: string, limit: number): number | null {
  if (Math.abs(left.length - right.length) > limit) return null;
  if (left === right) return 0;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      const value = Math.min(
        (previous[rightIndex] ?? limit + 1) + 1,
        (current[rightIndex - 1] ?? limit + 1) + 1,
        substitution,
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return null;
    previous = current;
  }

  const distance = previous[right.length] ?? limit + 1;
  return distance <= limit ? distance : null;
}

function subsequenceGap(term: string, candidate: string): number | null {
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const character of term) {
    const next = candidate.indexOf(character, cursor);
    if (next === -1) return null;
    if (first === -1) first = next;
    last = next;
    cursor = next + character.length;
  }
  return last - first + 1 - term.length;
}

function scoreFuzzyTerm(term: string, rawCandidate: string): number | null {
  const candidate = normalizeSearchText(rawCandidate);
  if (!candidate) return null;
  if (candidate === term) return 0;

  const exactIndex = candidate.indexOf(term);
  if (exactIndex >= 0) {
    const boundary = exactIndex === 0 || !/[\p{L}\p{N}]/u.test(candidate[exactIndex - 1] ?? "");
    return (boundary ? 3 : 8) + Math.min(exactIndex, 40) / 10;
  }

  const compactCandidate = candidate.replace(COMPACT_SEPARATOR, "");
  const compactTerm = term.replace(COMPACT_SEPARATOR, "");
  const compactIndex = compactCandidate.indexOf(compactTerm);
  if (compactTerm.length > 1 && compactIndex >= 0) {
    return 12 + Math.min(compactIndex, 40) / 10;
  }

  const words = candidate.match(WORD_PATTERN) ?? [];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const word of words) {
    if (word.startsWith(term)) {
      bestScore = Math.min(bestScore, 5 + Math.min(word.length - term.length, 12) / 4);
    }

    const editLimit = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
    if (editLimit > 0) {
      const distance = boundedEditDistance(term, word, editLimit);
      if (distance !== null) {
        bestScore = Math.min(bestScore, 24 + distance * 8 + Math.abs(word.length - term.length));
      }
    }

    if (term.length >= 3) {
      const gap = subsequenceGap(term, word);
      const maximumGap = Math.max(2, Math.floor(term.length * 0.65));
      if (gap !== null && gap <= maximumGap) {
        bestScore = Math.min(bestScore, 38 + gap * 3);
      }
    }
  }

  return Number.isFinite(bestScore) ? bestScore : null;
}

export function fuzzySearchScore(
  query: string,
  fields: readonly (string | null | undefined)[],
): number | null {
  const terms = tokenizeSearchQuery(query);
  if (terms.length === 0) return 0;

  let total = 0;
  for (const term of terms) {
    let bestScore = Number.POSITIVE_INFINITY;
    fields.forEach((field, fieldIndex) => {
      if (!field) return;
      const score = scoreFuzzyTerm(term, field);
      if (score !== null) bestScore = Math.min(bestScore, score + fieldIndex * 5);
    });
    if (!Number.isFinite(bestScore)) return null;
    total += bestScore;
  }

  const phrase = normalizeSearchText(query);
  const phraseFieldIndex = fields.findIndex((field) =>
    field ? normalizeSearchText(field).includes(phrase) : false,
  );
  if (phraseFieldIndex >= 0) total -= Math.max(2, 8 - phraseFieldIndex * 2);
  return Math.max(0, total);
}

export function rankFuzzySearchResults<T>(
  items: readonly T[],
  query: string,
  getFields: (item: T) => readonly (string | null | undefined)[],
  options: { includeUnmatched?: boolean } = {},
): T[] {
  if (tokenizeSearchQuery(query).length === 0) return [...items];

  return items
    .map<RankedItem<T>>((item, index) => ({
      item,
      index,
      score: fuzzySearchScore(query, getFields(item)),
    }))
    .filter((entry) => options.includeUnmatched || entry.score !== null)
    .sort((left, right) => {
      if (left.score === null) return right.score === null ? left.index - right.index : 1;
      if (right.score === null) return -1;
      return left.score - right.score || left.index - right.index;
    })
    .map((entry) => entry.item);
}

function mergeHighlightRanges(ranges: SearchHighlightRange[]): SearchHighlightRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: SearchHighlightRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

export function getSearchHighlightRanges(text: string, query: string): SearchHighlightRange[] {
  const terms = tokenizeSearchQuery(query);
  if (!text || terms.length === 0) return [];

  const loweredText = text.toLocaleLowerCase();
  const ranges: SearchHighlightRange[] = [];
  for (const term of terms) {
    let exactMatchFound = false;
    let cursor = 0;
    while (cursor < loweredText.length) {
      const index = loweredText.indexOf(term, cursor);
      if (index === -1) break;
      ranges.push({ start: index, end: index + term.length });
      exactMatchFound = true;
      cursor = index + Math.max(term.length, 1);
    }
    if (exactMatchFound) continue;

    WORD_PATTERN.lastIndex = 0;
    let bestWord: { start: number; end: number; score: number } | null = null;
    for (const match of text.matchAll(WORD_PATTERN)) {
      const word = match[0];
      const score = scoreFuzzyTerm(term, word);
      if (score === null || (bestWord && bestWord.score <= score)) continue;
      const start = match.index;
      bestWord = { start, end: start + word.length, score };
    }
    if (bestWord) ranges.push({ start: bestWord.start, end: bestWord.end });
  }

  return mergeHighlightRanges(ranges);
}
