/**
 * Linear's magic words: how a pull request's body names the issues it works
 * on. A closing word (`Completes DEV-123`) moves the issue when the pull
 * request merges; a non-closing one (`Part of DEV-123`) only links it. Each
 * word takes one issue, by its ID or by its URL, as Linear reads them.
 */

const CLOSING = 'close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving|complete[sd]?|completing';
const NON_CLOSING = String.raw`refs?|references|part\s+of|related\s+to|contributes\s+to|towards?`;
const ISSUE = String.raw`\s+(?:https://linear\.app/[^\s/]+/issue/)?([a-z]+-\d+)\b`;

export interface IssueLinks {
  /** Issues the pull request finishes, in the order the body names them. */
  closes: string[];
  /** Issues it works on without finishing them. */
  refs: string[];
}

/** The issues a body links, counting only the teams given; an ID is upper-cased, as Linear shows it. */
export function issueLinks(body: string, teamKeys: readonly string[]): IssueLinks {
  const keys = new Set(teamKeys.map((key) => key.toUpperCase()));
  const found = (words: string): string[] => {
    const ids = [...body.matchAll(new RegExp(String.raw`\b(?:${words})${ISSUE}`, 'gi'))].map((match) => (match[1] ?? '').toUpperCase());
    return [...new Set(ids.filter((id) => keys.has(id.slice(0, id.indexOf('-')))))];
  };
  return { closes: found(CLOSING), refs: found(NON_CLOSING) };
}
