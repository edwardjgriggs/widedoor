/*
 * Flesch-Kincaid grade level, for the plain-language text test. The syllable
 * count is the usual vowel-group heuristic: good enough to keep short, plain
 * sentences short and plain, not a linguistic tool.
 */

export function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  // Numbers and very short words count as one syllable.
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, w.match(/[aeiouy]{1,2}/g)?.length ?? 0);
}

export interface Readability {
  words: number;
  sentences: number;
  syllables: number;
  grade: number;
}

export function fleschKincaid(text: string): Readability {
  const words = text.match(/[A-Za-z0-9]+(?:['.-][A-Za-z0-9]+)*/g) ?? [];
  const sentences = Math.max(1, text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim()).length);
  const count = words.reduce((n, w) => n + syllables(w), 0);
  const perWord = words.length === 0 ? 0 : count / words.length;
  const grade = 0.39 * (words.length / sentences) + 11.8 * perWord - 15.59;
  return { words: words.length, sentences, syllables: count, grade };
}
