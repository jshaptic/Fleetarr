/**
 * The matching half of {@link BaseSelect}, kept out of the component so it can be read
 * and tested as what it is: a search, not a widget. Same split as `pagination.ts`.
 *
 * The values this picks between are container paths, and the interesting part of a path is
 * rarely its head - a fleet's folders all start `/data/media/`. So a query is split on
 * whitespace and every term has to appear *somewhere*, which makes `movies 4k` find
 * `/data/media/movies/russian/4k` without anybody typing the middle of it.
 */

/** What a caller may pass for one row. A bare value is the common case: value is label. */
export type SelectOption<T extends string = string> =
  | T
  | { readonly value: T; readonly label?: string; readonly hint?: string };

/** One row, after the two shapes above have been flattened into one. */
export interface SelectItem<T extends string = string> {
  readonly value: T;
  readonly label: string;
  /** A dimmed note after the label - what a row means, never what it is. */
  readonly hint: string | null;
}

/** A run of label text, flagged with whether the query put it there. */
export interface SelectSegment {
  readonly text: string;
  readonly match: boolean;
}

export function normalizeOptions<T extends string>(options: readonly SelectOption<T>[]): SelectItem<T>[] {
  return options.map((option) =>
    typeof option === 'string'
      ? { value: option, label: option, hint: null }
      : { value: option.value, label: option.label ?? option.value, hint: option.hint ?? null },
  );
}

/** The terms a query asks for. Empty query, no terms - which is "everything", not "nothing". */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((term) => term.length > 0))];
}

/**
 * Where a row belongs when several match.
 *
 * Only the query *as typed* can rank: a multi-term query describes a path's parts in an
 * order the path need not share, so there is nothing honest to sort it by and every row
 * scores the same - the caller's order then decides, which for paths is alphabetical.
 */
function score(label: string, query: string): number {
  const haystack = label.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  // A match that starts a path segment: `4k` should beat `/data/4k-archive/movies`.
  if (haystack.includes(`/${needle}`)) return 2;
  return 3;
}

/**
 * The rows a query leaves, best first. A row that matches nothing is dropped, never dimmed:
 * unlike the folder tree, nothing here is on the way to anything else.
 */
export function filterOptions<T extends string>(
  items: readonly SelectItem<T>[],
  query: string,
): SelectItem<T>[] {
  const terms = queryTerms(query);
  const kept = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const haystack = `${item.label} ${item.hint ?? ''}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });

  return kept
    .sort((left, right) => {
      const byScore = score(left.item.label, query) - score(right.item.label, query);
      return byScore === 0 ? left.index - right.index : byScore;
    })
    .map(({ item }) => item);
}

/**
 * The label cut into matched and unmatched runs, so a row can say *why* it is in the list.
 * Every occurrence of every term is marked, not just the first: a long path repeats words,
 * and highlighting one of three reads like the other two failed to match.
 */
export function highlightSegments(label: string, query: string): SelectSegment[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [{ text: label, match: false }];

  const haystack = label.toLowerCase();
  const marked = new Array<boolean>(label.length).fill(false);
  for (const term of terms) {
    let at = haystack.indexOf(term);
    while (at !== -1) {
      for (let index = at; index < at + term.length; index += 1) marked[index] = true;
      at = haystack.indexOf(term, at + 1);
    }
  }

  const segments: SelectSegment[] = [];
  for (let index = 0; index < label.length; index += 1) {
    const match = marked[index] === true;
    const last = segments.at(-1);
    if (last !== undefined && last.match === match) {
      segments[segments.length - 1] = { text: last.text + label[index], match };
    } else {
      segments.push({ text: label[index] ?? '', match });
    }
  }
  return segments;
}
