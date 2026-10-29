/**
 * Checks a pull request against the Git conventions (`rules.ts`). The action
 * (`action.yml`) runs it with the pull request from the event; on a laptop it
 * reads a real one from GitHub, or the same variables the action passes:
 *
 *   GITHUB_TOKEN="$(gh auth token)" GATE=test node pr-rules/check.ts --repo <owner>/<name> --pr <number>
 *   GATE=test PR_TITLE=… PR_BRANCH=… PR_BASE=… PR_BODY=… node pr-rules/check.ts
 *
 * Each broken rule is printed as an error that says how to fix it, and the
 * check fails. Plain Node, no dependencies: nothing is installed to run it.
 */
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { brokenRules, MAIN, PREFIXES, TEAM_KEYS, type PullRequest, type Rules } from './rules.ts';

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

/** A workflow command's text, escaped so a title cannot end it and start another. */
function command(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function report(broken: string[]): void {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  for (const rule of broken) console.log(inActions ? `::error title=Pull request rules::${command(rule)}` : `✗ ${rule}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(
      summary,
      broken.length === 0
        ? '### Pull request rules\n\nEvery rule holds.\n'
        : `### Pull request rules\n\n${broken.map((rule) => `- ${rule}`).join('\n')}\n`,
    );
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
  report(broken);
  if (broken.length > 0) process.exit(1);
}

await main();
