/**
 * What GitHub knows of a release: the commits the gate has and `main` does
 * not, the pull requests they name, and the previous release. `draft.ts` and
 * `pr-rules` read it the same way.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { MAIN, pullRequestNumbers, releaseOf, type MergedPullRequest, type OpenPullRequest, type Release } from './release.ts';

/** A read of GitHub's REST API. A 5xx is retried; anything else is an error that names the path, never the token. */
export async function github(path: string, token: string): Promise<unknown> {
  const api = process.env.GITHUB_API_URL?.trim() || 'https://api.github.com';
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${api}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (response.ok) return (await response.json()) as unknown;
    if (response.status < 500 || attempt === 3) throw new Error(`GitHub answered ${response.status} to GET ${path}`);
    await sleep(2_000 * attempt);
  }
}

interface RawPullRequest {
  number?: number;
  title?: string;
  body?: string | null;
  merged_at?: string | null;
  base?: { ref?: string };
  head?: { ref?: string };
}

function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`GitHub sent ${what} that is not a list`);
  return value;
}

/** The messages of every commit the gate has and `main` does not: `git log main..<gate>`. */
async function commitsAhead(repo: string, gate: string, token: string): Promise<string[]> {
  const messages: string[] = [];
  for (let page = 1; ; page += 1) {
    const comparison = (await github(`/repos/${repo}/compare/${MAIN}...${encodeURIComponent(gate)}?per_page=100&page=${page}`, token)) as {
      total_commits?: number;
      commits?: unknown;
    };
    const commits = asList(comparison.commits, 'the commits of a comparison') as { commit?: { message?: string } }[];
    messages.push(...commits.map((commit) => commit.commit?.message ?? ''));
    if (commits.length === 0 || messages.length >= (comparison.total_commits ?? 0)) return messages;
  }
}

/** The release pull request merged last, the gate → `main`. */
async function previousRelease(repo: string, gate: string, token: string): Promise<number | null> {
  const owner = repo.split('/')[0] ?? '';
  const pulls = asList(
    await github(`/repos/${repo}/pulls?state=closed&base=${MAIN}&head=${encodeURIComponent(`${owner}:${gate}`)}&sort=updated&direction=desc&per_page=30`, token),
    'the pull requests of a repo',
  ) as RawPullRequest[];
  const merged = pulls.filter((pr) => typeof pr.merged_at === 'string' && typeof pr.number === 'number');
  merged.sort((a, b) => (b.merged_at ?? '').localeCompare(a.merged_at ?? ''));
  return merged[0]?.number ?? null;
}

async function mergedPullRequest(repo: string, number: number, token: string): Promise<MergedPullRequest | null> {
  const pr = (await github(`/repos/${repo}/pulls/${number}`, token)) as RawPullRequest;
  if (typeof pr.merged_at !== 'string') return null;
  return { number, title: pr.title ?? '', body: pr.body ?? '', base: pr.base?.ref ?? '', head: pr.head?.ref ?? '' };
}

/** The release the gate holds today: everything it has that `main` does not. */
export async function releaseFromGitHub(repo: string, gate: string, teamKeys: readonly string[], token: string): Promise<Release> {
  const [messages, previous] = await Promise.all([commitsAhead(repo, gate, token), previousRelease(repo, gate, token)]);
  const pullRequests = await Promise.all(pullRequestNumbers(messages).map((number) => mergedPullRequest(repo, number, token)));
  return releaseOf(gate, previous, pullRequests.filter((pr) => pr !== null), teamKeys);
}

/**
 * What a merged release brought, from the release pull request itself: the
 * pull requests that entered the gate, one each, as its table lists them.
 * GitHub gives up to 250 commits of a pull request, plenty for a release.
 */
export async function pullRequestsOfRelease(repo: string, number: number, gate: string, token: string): Promise<MergedPullRequest[]> {
  const messages: string[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const commits = asList(await github(`/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`, token), 'the commits of a pull request') as {
      commit?: { message?: string };
    }[];
    messages.push(...commits.map((commit) => commit.commit?.message ?? ''));
    if (commits.length < 100) break;
  }
  const numbers = pullRequestNumbers(messages).filter((found) => found !== number);
  const pullRequests = await Promise.all(numbers.map((found) => mergedPullRequest(repo, found, token)));
  return releaseOf(gate, null, pullRequests.filter((pr) => pr !== null), []).rows;
}

/** The repo's open pull requests. */
export async function openPullRequests(repo: string, token: string): Promise<OpenPullRequest[]> {
  const open: OpenPullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const pulls = asList(await github(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, token), 'the open pull requests of a repo') as RawPullRequest[];
    for (const pr of pulls) {
      if (typeof pr.number === 'number') open.push({ number: pr.number, title: pr.title ?? '', body: pr.body ?? '', base: pr.base?.ref ?? '', head: pr.head?.ref ?? '' });
    }
    if (pulls.length < 100) return open;
  }
}
