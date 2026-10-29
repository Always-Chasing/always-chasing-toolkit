/**
 * Checks a pull request against the Git conventions (`rules.ts`). The action
 * (`action.yml`) runs it with the pull request from the event; on a laptop it
 * reads a real one from GitHub, or the same variables the action passes:
 *
 *   GITHUB_TOKEN="$(gh auth token)" GATE=test node pr-rules/check.ts --repo <owner>/<name> --pr <number>
 *   GATE=test PR_TITLE=… PR_BRANCH=… PR_BASE=… PR_BODY=… node pr-rules/check.ts
 *
 * A release is also checked against what it releases (`release-pr`): its body
 * has to complete every issue a pull request in it finishes. That reads
 * GitHub, with `GITHUB_TOKEN` and the repo (`GITHUB_REPOSITORY` in Actions).
 *
 * Each broken rule is printed as an error that says how to fix it, and the
 * check fails. Plain Node, no dependencies: nothing is installed to run it.
 */
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { releaseFromGitHub } from '../release-pr/github.ts';
import { checkBody } from '../release-pr/release.ts';
import { brokenRules, kindOf, MAIN, PREFIXES, TEAM_KEYS, type PullRequest, type Rules } from './rules.ts';

function fail(message: string): never {
  console.error(`pr-rules ✗  ${message}`);
  process.exit(1);
}

function setting(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';
  return value === '' ? null : value;
}

function words(name: string): string[] | null {
  const value = setting(name);
  return value === null ? null : value.split(/[\s,]+/).filter((word) => word !== '');
}

function rulesFromEnvironment(): Rules {
  const gate = setting('GATE');
  if (gate === MAIN) fail(`GATE is ${MAIN}: the gate is the branch before ${MAIN}, such as test. Leave it empty when pull requests go straight to ${MAIN}.`);
  const umbrellaOnly = setting('UMBRELLA_ONLY') ?? 'false';
  if (umbrellaOnly !== 'true' && umbrellaOnly !== 'false') fail(`UMBRELLA_ONLY is "${umbrellaOnly}": it takes true or false.`);
  const prefixes = words('PREFIXES') ?? PREFIXES;
  const wrongPrefix = prefixes.find((prefix) => !/^[a-z]+$/.test(prefix));
  if (wrongPrefix !== undefined) fail(`PREFIXES has "${wrongPrefix}": a prefix is lowercase letters, such as feature.`);
  const teamKeys = (words('TEAM_KEYS') ?? TEAM_KEYS).map((key) => key.toUpperCase());
  const wrongKey = teamKeys.find((key) => !/^[A-Z]+$/.test(key));
  if (wrongKey !== undefined) fail(`TEAM_KEYS has "${wrongKey}": a team key is letters, such as DEV.`);
  return { gate, umbrellaOnly: umbrellaOnly === 'true', prefixes, teamKeys };
}

async function pullRequestFromGitHub(repo: string, number: string): Promise<PullRequest> {
  const token = setting('GITHUB_TOKEN') ?? fail('GITHUB_TOKEN is not set. On a laptop: GITHUB_TOKEN="$(gh auth token)" node pr-rules/check.ts …');
  const api = setting('GITHUB_API_URL') ?? 'https://api.github.com';
  const response = await fetch(`${api}/repos/${repo}/pulls/${number}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) fail(`GitHub answered ${response.status} to the pull request ${repo}#${number}`);
  const pr = (await response.json()) as { title?: string; body?: string | null; head?: { ref?: string }; base?: { ref?: string } };
  return { title: pr.title ?? '', branch: pr.head?.ref ?? '', base: pr.base?.ref ?? '', body: pr.body ?? '' };
}

/** A release's body against what it releases: what breaks the rule, and what only deserves a look. */
async function releaseRules(pr: PullRequest, rules: Rules, repo: string | null): Promise<{ broken: string[]; warnings: string[] }> {
  const token = setting('GITHUB_TOKEN') ?? fail('GITHUB_TOKEN is not set: a release is checked against what it releases, read from GitHub.');
  if (repo === null) fail('GITHUB_REPOSITORY is not set: pass --repo <owner>/<name> --pr <number>.');
  const release = await releaseFromGitHub(repo, pr.branch, rules.teamKeys, token).catch((error: unknown) =>
    fail(`${error instanceof Error ? error.message : String(error)}. In Actions, the job needs contents: read and pull-requests: read.`),
  );
  const { missing, extra } = checkBody(release, pr.body, rules.teamKeys);
  const numbers = (pullRequests: number[]) => pullRequests.map((n) => `#${n}`).join(', ');
  return {
    broken: missing.map(
      (issue) =>
        `Body — the release does not complete ${issue.id}, which ${numbers(issue.pullRequests)} finishes. Add "Completes ${issue.id}": ` +
        `only the merge to ${MAIN} moves it to Done. release-pr/draft.ts in the toolkit writes the whole body.`,
    ),
    warnings: extra.map((id) => `Body — the release completes ${id}, and no pull request in it finishes that issue. Leave it only if it ships with this release.`),
  };
}

/** A workflow command's text, escaped so a title cannot end it and start another. */
function command(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function report(broken: string[], warnings: string[]): void {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  for (const rule of broken) console.log(inActions ? `::error title=Pull request rules::${command(rule)}` : `✗ ${rule}`);
  for (const warning of warnings) console.log(inActions ? `::warning title=Pull request rules::${command(warning)}` : `! ${warning}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [...broken.map((rule) => `- ✗ ${rule}`), ...warnings.map((warning) => `- ${warning}`)];
    appendFileSync(summary, `### Pull request rules\n\n${broken.length === 0 ? 'Every rule holds.\n' : ''}${lines.length === 0 ? '' : `\n${lines.join('\n')}\n`}`);
  }
  if (broken.length === 0) console.log('✓ Every rule holds: the title, the branch, the base and the link to Linear.');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, pr: { type: 'string' } } });
  const rules = rulesFromEnvironment();
  if ((values.repo === undefined) !== (values.pr === undefined)) fail('--repo and --pr go together: --repo <owner>/<name> --pr <number>');
  const pr =
    values.repo !== undefined && values.pr !== undefined
      ? await pullRequestFromGitHub(values.repo, values.pr)
      : { title: setting('PR_TITLE') ?? '', branch: setting('PR_BRANCH') ?? '', base: setting('PR_BASE') ?? '', body: process.env.PR_BODY ?? '' };
  if (pr.branch === '' || pr.base === '') fail('PR_BRANCH and PR_BASE are not set: there is no pull request to check');
  const broken = brokenRules(pr, rules);
  const warnings: string[] = [];
  if (kindOf(pr.branch, rules) === 'release' && pr.base === MAIN) {
    const release = await releaseRules(pr, rules, values.repo ?? setting('GITHUB_REPOSITORY'));
    broken.push(...release.broken);
    warnings.push(...release.warnings);
  }
  report(broken, warnings);
  if (broken.length > 0) process.exit(1);
}

await main();
