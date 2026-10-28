import path from 'node:path';

// A port of the scorer the command palette ranks files with: cmdk's `defaultFilter`, which is
// cmdk's copy of the command-score package. The palette scores a file by its path relative to the
// project root, so the server's best matches are the rows the palette would rank first had it
// listed every file. Keep the constants and branches in step with cmdk; the File Tree tests
// compare this port against cmdk itself.

// A continuous match of characters scores 1 in total.
const SCORE_CONTINUE_MATCH = 1;
// A match at the start of a word scores better than one elsewhere; words split by spaces a
// little better than words split by slashes, dots and the like.
const SCORE_SPACE_WORD_JUMP = 0.9;
const SCORE_NON_SPACE_WORD_JUMP = 0.8;
const SCORE_CHARACTER_JUMP = 0.17;
// Two transposed letters are penalised heavily.
const SCORE_TRANSPOSITION = 0.1;
// The match decays slightly with every character skipped between matches.
const PENALTY_SKIPPED = 0.999;
// An exact-case match beats a case-insensitive one by a hair.
const PENALTY_CASE_MISMATCH = 0.9999;
// A string longer than what was typed scores a little lower than an exact match.
const PENALTY_NOT_COMPLETE = 0.99;

const IS_GAP_REGEXP = /[\\\/_+.#"@\[\(\{&]/;
const COUNT_GAPS_REGEXP = /[\\\/_+.#"@\[\(\{&]/g;
const IS_SPACE_REGEXP = /[\s-]/;
const COUNT_SPACE_REGEXP = /[\s-]/g;

// Scoring a path takes time that grows with its length squared times the search's, the more so
// the more often the search's characters repeat in it. It is counted in steps of 10 to 50ns each:
// a loop round takes one, three when it works out the jump to a better match or tries two
// transposed letters and five when it does both, and every character scanned to count word breaks
// takes one. Everyday paths take a few thousand steps, and a search pasted whole on an ordinary
// path of 500 characters up to about 180,000. A path that takes more scores 0, about 10ms in at
// the most: only longer paths, and contrived ones such as a letter repeated a hundred times or
// alternating with another, score differently from the palette.
const MAXIMUM_SCORE_STEPS = 200_000;
// The steps a loop round's costlier parts add to its own: working out the jump to a better match,
// and scoring the rest past two transposed letters.
const COSTLY_ROUND_PART_STEPS = 2;

/** Unwinds a scoring given up on, which leaves the path at 0. */
class AbandonedScoreError extends Error {}

/**
 * The strings being scored, in their typed and their lower-cased form, the memo of one scoring
 * and how many steps it has taken.
 */
type CommandScoreInput = {
  text: string;
  abbreviation: string;
  lowerText: string;
  lowerAbbreviation: string;
  // Keyed by textIndex * (lowerAbbreviation.length + 1) + abbreviationIndex, unique since
  // abbreviationIndex stays below lowerAbbreviation.length; cmdk keys the same results by a
  // string, which is slower and scores alike.
  memo: Map<number, number>;
  steps: number;
};

function scoreFrom(input: CommandScoreInput, textIndex: number, abbreviationIndex: number): number {
  const { text, abbreviation, lowerText, lowerAbbreviation, memo } = input;
  if (abbreviationIndex === abbreviation.length) {
    return textIndex === text.length ? SCORE_CONTINUE_MATCH : PENALTY_NOT_COMPLETE;
  }
  // Past the end of the lower-cased search, which only a transposition over the last typed
  // character leads to, and only when the search lower-cases longer than typed ('İ'). cmdk
  // matches the empty string there and recurses until its stack overflows, so the palette could
  // never show the path; given up on here instead.
  if (abbreviationIndex >= lowerAbbreviation.length) {
    throw new AbandonedScoreError();
  }

  const memoKey = textIndex * (lowerAbbreviation.length + 1) + abbreviationIndex;
  const memoized = memo.get(memoKey);
  if (memoized !== undefined) {
    return memoized;
  }

  const abbreviationCharacter = lowerAbbreviation.charAt(abbreviationIndex);
  let index = lowerText.indexOf(abbreviationCharacter, textIndex);
  let highScore = 0;

  while (index >= 0) {
    input.steps += 1;
    if (input.steps > MAXIMUM_SCORE_STEPS) {
      throw new AbandonedScoreError();
    }
    let score = scoreFrom(input, index + 1, abbreviationIndex + 1);
    if (score > highScore) {
      input.steps += COSTLY_ROUND_PART_STEPS;
      if (index === textIndex) {
        score *= SCORE_CONTINUE_MATCH;
      } else if (IS_GAP_REGEXP.test(text.charAt(index - 1))) {
        score *= SCORE_NON_SPACE_WORD_JUMP;
        input.steps += index - textIndex;
        const wordBreaks = text.slice(textIndex, index - 1).match(COUNT_GAPS_REGEXP);
        if (wordBreaks && textIndex > 0) {
          score *= Math.pow(PENALTY_SKIPPED, wordBreaks.length);
        }
      } else if (IS_SPACE_REGEXP.test(text.charAt(index - 1))) {
        score *= SCORE_SPACE_WORD_JUMP;
        input.steps += index - textIndex;
        const spaceBreaks = text.slice(textIndex, index - 1).match(COUNT_SPACE_REGEXP);
        if (spaceBreaks && textIndex > 0) {
          score *= Math.pow(PENALTY_SKIPPED, spaceBreaks.length);
        }
      } else {
        score *= SCORE_CHARACTER_JUMP;
        if (textIndex > 0) {
          score *= Math.pow(PENALTY_SKIPPED, index - textIndex);
        }
      }

      if (text.charAt(index) !== abbreviation.charAt(abbreviationIndex)) {
        score *= PENALTY_CASE_MISMATCH;
      }
    }

    // Transposed letters, and a doubled letter typed where the text has it once.
    if (
      (score < SCORE_TRANSPOSITION
        && lowerText.charAt(index - 1) === lowerAbbreviation.charAt(abbreviationIndex + 1))
      || (lowerAbbreviation.charAt(abbreviationIndex + 1) === lowerAbbreviation.charAt(abbreviationIndex)
        && lowerText.charAt(index - 1) !== lowerAbbreviation.charAt(abbreviationIndex))
    ) {
      input.steps += COSTLY_ROUND_PART_STEPS;
      const transposedScore = scoreFrom(input, index + 1, abbreviationIndex + 2);
      if (transposedScore * SCORE_TRANSPOSITION > score) {
        score = transposedScore * SCORE_TRANSPOSITION;
      }
    }

    if (score > highScore) {
      highScore = score;
    }

    index = lowerText.indexOf(abbreviationCharacter, index + 1);
  }

  memo.set(memoKey, highScore);
  return highScore;
}

// Every kind of space and the hyphen match one another.
function formatScoreInput(value: string): string {
  return value.toLowerCase().replace(COUNT_SPACE_REGEXP, ' ');
}

/**
 * Scores files against one search the way the command palette's `scoreFile` does, for the File
 * Tree service's project file search. Returns how well a path relative to the project root
 * matches `query`, from 0 (no match) to 1. A pasted absolute path is read relative to the project
 * root first, and backslashes count as forward slashes, as in the palette. A path that would take
 * too long to score scores 0 (see MAXIMUM_SCORE_STEPS), as does one that overflows cmdk's stack.
 */
export function createFileSearchScorer(projectRoot: string, query: string): (relativePath: string) => number {
  // The root as the files' absolute paths spell it, trailing separator included.
  const rootPrefix = path.join(projectRoot, path.sep).replace(/\\/g, '/');
  const normalizedQuery = query.replace(/\\/g, '/');
  const abbreviation = normalizedQuery.startsWith(rootPrefix)
    ? normalizedQuery.slice(rootPrefix.length)
    : normalizedQuery;
  const lowerAbbreviation = formatScoreInput(abbreviation);
  // A path scores above 0 by the first abbreviation.length code units of the lower-cased search
  // alone; the rest, there when the search lower-cases longer than typed ('İ', U+0130, becomes 'i'
  // and U+0307), never count. Each of those first code units shows up somewhere in such a path:
  // it is either matched or, in the transposition branch, equal to a character of the path or to
  // one that is matched. Paths missing one are skipped without being scored. Split into UTF-16
  // code units, which is what the scorer compares.
  const requiredCharacters = [...new Set(lowerAbbreviation.slice(0, abbreviation.length).split(''))];

  return (relativePath) => {
    const text = relativePath.replace(/\\/g, '/');
    const lowerText = formatScoreInput(text);
    if (!requiredCharacters.every((character) => lowerText.includes(character))) {
      return 0;
    }
    try {
      return scoreFrom({ text, abbreviation, lowerText, lowerAbbreviation, memo: new Map(), steps: 0 }, 0, 0);
    } catch (error) {
      if (error instanceof AbandonedScoreError) {
        return 0;
      }
      throw error;
    }
  };
}
