/**
 * Drafts the release pull request, the gate → `main`, from a project's
 * checkout:
 *
 *   GITHUB_TOKEN="$(gh auth token)" \
 *   LINEAR_API_KEY="$(security find-generic-password -s always-chasing-linear-api -w)" \
 *     node ~/projects/always-chasing-toolkit/release-pr/draft.ts --gate test > release.md
 *
 * The body goes to stdout: the pull requests that entered the gate since the
 * previous release, one row each, and a `Completes` line for each issue they
 * finish (`release.ts`). The rest goes to stderr: what was found, and how it
 * compares with the issues of one Linear team in In Test that a pull request
 * of this repo links. It exits 1 when they differ, after writing the body.
 *
 * The Linear key is read from the environment and goes nowhere but Linear's
 * API; without it, the comparison is left out. Plain Node, no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { releaseFromGitHub } from './github.ts';
import { compareWithInTest, releaseBody, type LinearIssue, type Release } from './release.ts';

const LINEAR_API = 'https://api.linear.app/graphql';
const IN_TEST = 'In Test';

function fail(message: string): never {
  console.error(`release-pr ✗  ${message}`);
  process.exit(1);
}

function setting(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';
  return value === '' ? null : value;
}

/** `<owner>/<name>` of the checkout's `origin` on GitHub. */
function repoOfCheckout(): string {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    fail('this is not a checkout with an origin: run it from the project, or pass --repo <owner>/<name>');
  }
  const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
  return repo ?? fail(`origin is not on GitHub (${url}): pass --repo <owner>/<name>`);
}

async function linear<T>(key: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = (await response.json().catch(() => ({}))) as { data?: T; errors?: { message?: string }[] };
  if (!response.ok || answer.data === undefined) {
    fail(`Linear answered ${response.status}: ${answer.errors?.map((error) => error.message).join('; ') ?? 'no data'}`);
  }
  return answer.data;
}

interface LinearNode {
  identifier: string;
  title: string;
  state: { name: string };
  attachments?: { nodes: { url: string }[] };
}

/** The team's issues in In Test that a pull request of this repo links. */
async function inTestOf(key: string, team: string, repo: string): Promise<LinearIssue[]> {
  const pulls = `https://github.com/${repo}/pull/`.toLowerCase();
  const found: LinearIssue[] = [];
  let after: string | null = null;
  for (;;) {
    const data: { issues: { nodes: LinearNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await linear(
      key,
      `query ($team: String!, $state: String!, $after: String) {
        issues(first: 50, after: $after, filter: { team: { key: { eq: $team } }, state: { name: { eq: $state } } }) {
          nodes { identifier title state { name } attachments(first: 20) { nodes { url } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { team, state: IN_TEST, after },
    );
    for (const node of data.issues.nodes) {
      if (node.attachments?.nodes.some((attachment) => attachment.url.toLowerCase().startsWith(pulls))) {
        found.push({ id: node.identifier, title: node.title, state: node.state.name });
      }
    }
    if (!data.issues.pageInfo.hasNextPage) return found;
    after = data.issues.pageInfo.endCursor;
  }
}

/** The state of each of the team's issues the release completes. */
async function statesOf(key: string, team: string, release: Release): Promise<Map<string, string>> {
  const numbers = release.completes.filter((issue) => issue.id.startsWith(`${team}-`)).map((issue) => Number(issue.id.slice(team.length + 1)));
  if (numbers.length === 0) return new Map();
  const data = await linear<{ issues: { nodes: LinearNode[] } }>(
    key,
    `query ($team: String!, $numbers: [Float!]) {
      issues(first: 250, filter: { team: { key: { eq: $team } }, number: { in: $numbers } }) { nodes { identifier title state { name } } }
    }`,
    { team, numbers },
  );
  return new Map(data.issues.nodes.map((node) => [node.identifier, node.state.name]));
}

const numbers = (pullRequests: number[]) => pullRequests.map((n) => `#${n}`).join(', ');

function describe(release: Release): void {
  const since = release.previous === null ? '' : ` since #${release.previous}`;
  if (release.rows.length === 0) {
    console.error(`· Nothing entered ${release.gate}${since}: there is nothing to release.`);
    return;
  }
  const count = release.rows.length === 1 ? 'One pull request' : `${release.rows.length} pull requests`;
  console.error(`· ${count} entered ${release.gate}${since}: ${numbers(release.rows.map((pr) => pr.number))}.`);
  console.error(
    release.completes.length === 0
      ? '· None of them finishes a Linear issue.'
      : `· The release completes ${release.completes.map((issue) => issue.id).join(', ')}.`,
  );
  for (const issue of release.stillOpen) console.error(`· ${issue.id} stays open: ${numbers(issue.pullRequests)} only work on it.`);
}

async function compare(release: Release, repo: string, team: string): Promise<boolean> {
  const key = setting('LINEAR_API_KEY');
  if (key === null) {
    console.error('· LINEAR_API_KEY is not set: the release was not compared with In Test.');
    return true;
  }
  const [inTest, states] = await Promise.all([inTestOf(key, team, repo), statesOf(key, team, release)]);
  const comparison = compareWithInTest(release, team, IN_TEST, inTest, states);
  for (const { issue, state } of comparison.notInTest) {
    console.error(
      state === null
        ? `✗ ${issue.id}, which ${numbers(issue.pullRequests)} completes, is not an issue of ${team} that Linear knows.`
        : `✗ ${issue.id} is in ${state}, not in ${IN_TEST}, and ${numbers(issue.pullRequests)} completes it. Check it in Linear before releasing.`,
    );
  }
  for (const issue of comparison.notReleased) {
    console.error(
      `✗ ${issue.id} «${issue.title}» is in ${IN_TEST}, and no pull request of the release completes it. ` +
        `If it ships now, say "Completes ${issue.id}" in the body of the pull request that finished it, and draft again; if not, move it in Linear.`,
    );
  }
  const same = comparison.notInTest.length === 0 && comparison.notReleased.length === 0;
  if (same) console.error(`✓ Linear: the issues of ${team} in ${IN_TEST} that this repo links are the ones the release completes.`);
  return same;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      gate: { type: 'string', default: 'test' },
      team: { type: 'string', default: 'DEV' },
      'team-keys': { type: 'string', default: 'DEV OPS INT' },
    },
  });
  const token = setting('GITHUB_TOKEN') ?? fail('GITHUB_TOKEN is not set: GITHUB_TOKEN="$(gh auth token)" node …/release-pr/draft.ts …');
  const repo = values.repo ?? repoOfCheckout();
  const team = values.team.toUpperCase();
  const teamKeys = values['team-keys'].split(/[\s,]+/).filter((key) => key !== '').map((key) => key.toUpperCase());

  const release = await releaseFromGitHub(repo, values.gate, teamKeys, token).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  process.stdout.write(releaseBody(release));
  describe(release);
  const same = await compare(release, repo, team);
  if (release.rows.length > 0) {
    console.error(
      `Next: describe each row in your own words, add what is worth knowing before production, and open it:\n` +
        `  gh pr create --repo ${repo} --base main --head ${values.gate} --title "chore: release … to production" --body-file release.md`,
    );
  }
  if (!same) process.exit(1);
}

await main();
