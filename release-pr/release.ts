/**
 * The release pull request, the gate → `main`, and what it has to say.
 *
 * In team DEV a merge to the gate moves an issue to In Test, and only the
 * merge to `main` moves it to Done. A pull request that gathers others does
 * not inherit their issues, so the release names every issue that entered the
 * gate since the previous release, one `Completes` line each, or that issue
 * never reaches Done.
 *
 * What entered the gate is read from its commits that `main` does not have —
 * `git log origin/main..origin/test` —: each squashed pull request ends its
 * subject in `(#N)`, and each umbrella entered as `Merge pull request #N from
 * …/project/<slug>`, with its tasks' squashed commits behind it. Each of those
 * pull requests brings the magic words of its body. The rules here are pure;
 * `github.ts` reads GitHub, `draft.ts` writes the body and compares it with
 * Linear, and `pr-rules` checks a release against it.
 */
import { summaryOf } from '../lib/conventional.ts';
import { issueLinks } from '../lib/linear.ts';

export const MAIN = 'main';

export interface MergedPullRequest {
  number: number;
  title: string;
  body: string;
  /** The branch it merged into. */
  base: string;
  /** The branch it came from. */
  head: string;
}

/** An issue and the pull requests of the release that name it. */
export interface ReleaseIssue {
  id: string;
  pullRequests: number[];
}

export interface Release {
  gate: string;
  /** The previous release pull request, if there was one. */
  previous: number | null;
  /** What entered the gate itself, one row each: umbrellas, tasks, hotfixes, Dependabot. */
  rows: MergedPullRequest[];
  /** The issues some pull request of the release finishes: one `Completes` line each. */
  completes: ReleaseIssue[];
  /** The issues the release works on and none of its pull requests finishes: they stay open. */
  stillOpen: ReleaseIssue[];
}

/**
 * The pull requests a range of commits names, in the order of the numbers:
 * `<title> (#N)` for a squash, `Merge pull request #N from <owner>/<branch>`
 * for a merge commit. Any other commit names none.
 */
export function pullRequestNumbers(messages: readonly string[]): number[] {
  const numbers = new Set<number>();
  for (const message of messages) {
    const subject = message.split('\n', 1)[0]?.trim() ?? '';
    const match = /^Merge pull request #(\d+) from \S+/.exec(subject) ?? /\s\(#(\d+)\)$/.exec(subject);
    if (match?.[1] !== undefined) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Sorts issue IDs by team, then by number: DEV-9 before DEV-10. */
export function byIssue(a: string, b: string): number {
  const [keyA = '', numberA = '0'] = a.split('-');
  const [keyB = '', numberB = '0'] = b.split('-');
  return keyA === keyB ? Number(numberA) - Number(numberB) : keyA.localeCompare(keyB);
}

function issues(found: Map<string, number[]>): ReleaseIssue[] {
  return [...found.keys()].sort(byIssue).map((id) => ({ id, pullRequests: [...new Set(found.get(id))].sort((a, b) => a - b) }));
}

/**
 * The release that gathers the given pull requests. A pull request from
 * `main` is a sync, whose commits production already has, and is left out.
 */
export function releaseOf(gate: string, previous: number | null, pullRequests: readonly MergedPullRequest[], teamKeys: readonly string[]): Release {
  const counted = pullRequests.filter((pr) => pr.head !== MAIN).sort((a, b) => a.number - b.number);
  const closes = new Map<string, number[]>();
  const refs = new Map<string, number[]>();
  for (const pr of counted) {
    const links = issueLinks(pr.body, teamKeys);
    for (const id of links.closes) closes.set(id, [...(closes.get(id) ?? []), pr.number]);
    for (const id of links.refs) refs.set(id, [...(refs.get(id) ?? []), pr.number]);
  }
  for (const id of closes.keys()) refs.delete(id);
  return { gate, previous, rows: counted.filter((pr) => pr.base === gate), completes: issues(closes), stillOpen: issues(refs) };
}

/** A row's words, from its title: `feat(board): drag a card` → `Drag a card`. Edited by hand before it goes out. */
export function whatProductionGets(title: string): string {
  return summaryOf(title).replaceAll('|', '\\|');
}

const numbers = (pullRequests: number[]) => pullRequests.map((n) => `#${n}`).join(', ');

/** The body of the release pull request, in the shape Control Tower's releases took. */
export function releaseBody(release: Release): string {
  const since = release.previous === null ? '' : ` since the previous release (#${release.previous})`;
  const lines = [
    '## What this PR does',
    '',
    `Releases to production what entered \`${release.gate}\`${since}:`,
    '',
    '| PR | What production gets |',
    '|---|---|',
    ...release.rows.map((pr) => `| #${pr.number} | ${whatProductionGets(pr.title)} |`),
    '',
    '## Why',
    '',
  ];
  if (release.completes.length === 0) lines.push('No pull request in this release finishes a Linear issue.');
  else lines.push(...release.completes.map((issue) => `Completes ${issue.id}`));
  if (release.stillOpen.length > 0) {
    // Bare IDs: a magic word would link the release to them.
    lines.push('', `Still open after this release: ${release.stillOpen.map((issue) => `${issue.id} (${numbers(issue.pullRequests)})`).join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}

/** What a release pull request's body says against what it releases. */
export interface BodyCheck {
  /** Issues the release finishes and its body does not complete: they would never reach Done. */
  missing: ReleaseIssue[];
  /** Issues the body completes and no pull request of the release finishes. */
  extra: string[];
}

export function checkBody(release: Release, body: string, teamKeys: readonly string[]): BodyCheck {
  const said = new Set(issueLinks(body, teamKeys).closes);
  const released = new Set(release.completes.map((issue) => issue.id));
  return {
    missing: release.completes.filter((issue) => !said.has(issue.id)),
    extra: [...said].filter((id) => !released.has(id)).sort(byIssue),
  };
}

/** An issue as Linear has it. */
export interface LinearIssue {
  id: string;
  title: string;
  state: string;
}

/** The release against Linear: one team's issues in its In Test state, linked to a pull request of this repo. */
export interface Comparison {
  /** Issues the release completes that are not in In Test, with the state they are in, or null when Linear has no such issue. */
  notInTest: { issue: ReleaseIssue; state: string | null }[];
  /** Issues in In Test the release does not complete. */
  notReleased: LinearIssue[];
}

export function compareWithInTest(release: Release, team: string, inTestState: string, inTest: readonly LinearIssue[], states: ReadonlyMap<string, string>): Comparison {
  const released = new Set(release.completes.map((issue) => issue.id));
  return {
    notInTest: release.completes
      .filter((issue) => issue.id.startsWith(`${team}-`) && states.get(issue.id) !== inTestState)
      .map((issue) => ({ issue, state: states.get(issue.id) ?? null })),
    notReleased: inTest.filter((issue) => !released.has(issue.id)).sort((a, b) => byIssue(a.id, b.id)),
  };
}
