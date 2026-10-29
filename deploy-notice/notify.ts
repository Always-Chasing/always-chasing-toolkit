/**
 * Tells Slack what happened to a deploy of `test` or production. The action
 * (`action.yml`) runs it; on a laptop it runs as
 *
 *   GITHUB_TOKEN="$(gh auth token)" PROJECT=… PRODUCTION_URL=… [TEST_URL=…] \
 *     node deploy-notice/notify.ts --repo <owner>/<name> --deployment <id> --dry-run
 *   … node deploy-notice/notify.ts --repo <owner>/<name> --release <sha> --dry-run
 *
 * The deploy notice (`--deployment`, or `DEPLOYMENT_ID`) asks three questions,
 * in order, and stops at the first bad answer:
 *
 *   1. Did Vercel build it? — the state of the GitHub deployment Vercel created.
 *   2. Did Supabase apply the migrations of that commit, and the buckets
 *      after them? — its «Supabase Preview» check run, waited for up to
 *      `MIGRATIONS_WAIT_MINUTES`: the same wait the Vercel Deployment Check
 *      should give production before it gives up. A failed run's summary says
 *      at which step.
 *   3. Does the environment's domain serve it? — the deployment id Next
 *      stamps on every navigation response and page (`x-nextjs-deployment-id`,
 *      `<html data-dpl-id>`), compared with the one the deployment's own URL
 *      serves, for up to 5 minutes. A newer deployment of the same environment
 *      counts: it contains this one.
 *
 * In a production that waits for its migrations, GitHub hears of the
 * deployment only at the end of the wait, when Vercel publishes it or holds it
 * back, so a release whose wait never ends never gets there. The release watch
 * (`--release`, or `RELEASE_SHA`) starts with the merge to the release branch
 * instead: it waits for Supabase the same minutes, and then for the «Vercel»
 * commit status to say the deployment was published. It speaks only when the
 * deploy notice cannot: a Supabase check that failed or stalled, or a database
 * that is ready while Vercel does not publish.
 *
 * The pull request behind the commit comes from GitHub, never from the
 * commit's text: a release names its own and lists what it brought. Vercel may
 * report one deployment twice (`DEPLOYMENT_STATUS_ID` says which report started
 * the run), and only the first report of each state is told.
 *
 * The answers become one notice (`notice.ts`), posted to the Slack webhook —
 * or printed, with `--dry-run`, which is how a notice is tried against a real
 * deploy without posting anything.
 *
 * Plain Node, no dependencies: the action runs it without installing anything.
 * Nothing here needs Vercel or Supabase credentials: everything is read from
 * GitHub and from the public domains. The one secret is the webhook.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { payload, plainText, postToSlack } from '../lib/slack.ts';
import { pullRequestsOfRelease } from '../release-pr/github.ts';
import {
  buildOutcome,
  builtByVercel,
  deploymentMarker,
  environmentOf,
  failedSupabaseStep,
  leftToReleaseWatch,
  migrationsOutcome,
  publicationOutcome,
  pullRequestsIn,
  releaseNotice,
  renderNotice,
  repeatsEarlierStatus,
  type DeployEnvironment,
  type EnvironmentNames,
  type Notice,
  type NoticeKind,
  type PullRequest,
  type SupabaseStep,
} from './notice.ts';

/** After the migrations land, Vercel takes the new version within seconds; five minutes means it did not. */
const SERVED_WAIT_MINUTES = 5;
/**
 * The release watch's wait for Vercel once the migrations landed. A release
 * without migrations can be through Supabase before its build is: the build
 * takes about a minute, the domains follow the migrations within seconds, and
 * ten minutes means Vercel did not publish.
 */
const PUBLISH_WAIT_MINUTES = 10;
const MIGRATIONS_POLL_MS = 15_000;
const SERVED_POLL_MS = 10_000;

interface Config {
  project: string;
  repo: string;
  /** Where each environment is served; a project without `test` has no domain for it. */
  domains: Record<DeployEnvironment, string | null>;
  environments: EnvironmentNames;
  /** A page that answers on every host without a session, and better without the database. */
  probePath: string;
  supabaseCheck: string;
  releaseBranch: string;
  /** The branch `test` deploys from, such as `test` or `staging`: what messages call it, and where releases start. */
  testBranch: string;
  migrationsWaitMinutes: number;
  /** The repo on GitHub, where commit and pull request links start. */
  repoUrl: string;
}

interface Deployment {
  id: number;
  sha: string;
  environment: string;
}

interface DeploymentStatus {
  id: number;
  state: string;
  description: string | null;
  environmentUrl: string | null;
  targetUrl: string | null;
  logUrl: string | null;
}

interface CheckRun {
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
  app: string | null;
  summary: string | null;
}

interface CommitStatus {
  context: string;
  state: string;
  targetUrl: string | null;
  creator: string | null;
}

interface DeploymentFacts {
  id: number;
  sha: string;
  githubEnvironment: string;
  /** The last final state Vercel reported: `success`, `failure` or `error`. */
  state: string;
  /** The deployment's own URL on Vercel. */
  url: string;
  logs: string | null;
  /** Vercel's own words for that state; on a failure, the command that prints the build's logs. */
  description: string | null;
}

function fail(message: string): never {
  console.error(`deploy-notice ✗  ${message}`);
  process.exit(1);
}

// What GitHub answers, checked before it is believed.

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`GitHub sent ${what} that is not an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`GitHub sent ${what} that is not a list`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`GitHub sent ${what} without its text`);
  return value;
}

function maybeText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toDeployment(raw: unknown): Deployment {
  const deployment = object(raw, 'a deployment');
  if (typeof deployment.id !== 'number') fail('GitHub sent a deployment without its id');
  return { id: deployment.id, sha: text(deployment.sha, 'a deployment'), environment: text(deployment.environment, 'a deployment') };
}

function toDeploymentStatus(raw: unknown): DeploymentStatus {
  const status = object(raw, 'a deployment status');
  if (typeof status.id !== 'number') fail('GitHub sent a deployment status without its id');
  return {
    id: status.id,
    state: text(status.state, 'a deployment status'),
    description: maybeText(status.description),
    environmentUrl: maybeText(status.environment_url),
    targetUrl: maybeText(status.target_url),
    logUrl: maybeText(status.log_url),
  };
}

function toCheckRun(raw: unknown): CheckRun {
  const run = object(raw, 'a check run');
  const app = typeof run.app === 'object' && run.app !== null ? maybeText((run.app as Record<string, unknown>).slug) : null;
  const output = typeof run.output === 'object' && run.output !== null ? (run.output as Record<string, unknown>) : {};
  return {
    status: text(run.status, 'a check run'),
    conclusion: maybeText(run.conclusion),
    htmlUrl: maybeText(run.html_url),
    app,
    summary: maybeText(output.summary),
  };
}

function toCommitStatus(raw: unknown): CommitStatus {
  const status = object(raw, 'a commit status');
  const creator = typeof status.creator === 'object' && status.creator !== null ? maybeText((status.creator as Record<string, unknown>).login) : null;
  return { context: text(status.context, 'a commit status'), state: text(status.state, 'a commit status'), targetUrl: maybeText(status.target_url), creator };
}

function subjectOf(message: string): string {
  return message.split('\n')[0] ?? '';
}

// The configuration, from the action's inputs or the laptop's environment.

function setting(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';
  return value === '' ? null : value;
}

function origin(name: string, raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.origin;
  } catch {
    // Falls through to the failure below.
  }
  fail(`${name} is not an https address: ${raw}`);
}

function repository(given: string | undefined): string {
  const named = given ?? setting('GITHUB_REPOSITORY');
  if (named) return named;
  const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
  const match = /github\.com[:/](.+?\/.+?)(?:\.git)?$/.exec(remote);
  if (!match?.[1]) fail(`cannot tell the GitHub repository from the remote "${remote}"; pass --repo <owner>/<name>`);
  return match[1];
}

function configure(given: string | undefined): Config {
  const repo = repository(given);
  const project = setting('PROJECT') ?? fail('PROJECT is not set: every message starts with the project name');
  const production = setting('PRODUCTION_URL') ?? fail('PRODUCTION_URL is not set');
  const test = setting('TEST_URL');
  const wait = Number(setting('MIGRATIONS_WAIT_MINUTES') ?? '30');
  if (!Number.isInteger(wait) || wait < 1 || wait > 40) fail('MIGRATIONS_WAIT_MINUTES must be a whole number of minutes, from 1 to 40');
  return {
    project,
    repo,
    domains: { production: origin('PRODUCTION_URL', production), test: test === null ? null : origin('TEST_URL', test) },
    environments: {
      production: setting('PRODUCTION_ENVIRONMENT') ?? 'Production',
      test: test === null ? null : (setting('TEST_ENVIRONMENT') ?? 'staging'),
    },
    probePath: setting('PROBE_PATH') ?? '/',
    supabaseCheck: setting('SUPABASE_CHECK') ?? 'Supabase Preview',
    releaseBranch: setting('RELEASE_BRANCH') ?? 'main',
    testBranch: setting('TEST_BRANCH') ?? 'test',
    migrationsWaitMinutes: wait,
    repoUrl: `${setting('GITHUB_SERVER_URL') ?? 'https://github.com'}/${repo}`,
  };
}

async function github(path: string): Promise<unknown> {
  const token = setting('GITHUB_TOKEN') ?? fail('GITHUB_TOKEN is not set. On a laptop: GITHUB_TOKEN="$(gh auth token)" node deploy-notice/notify.ts …');
  const api = setting('GITHUB_API_URL') ?? 'https://api.github.com';
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${api}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (response.ok) return (await response.json()) as unknown;
    // A 5xx is GitHub's to fix and usually gone in seconds; anything else is ours.
    if (response.status < 500 || attempt === 3) fail(`GitHub answered ${response.status} to GET ${path}`);
    await sleep(2_000 * attempt);
  }
}

/** A read that may be refused: the pull requests, when the job lacks `pull-requests: read`. The notice goes out without them. */
async function githubIfAllowed(path: string): Promise<unknown> {
  const token = setting('GITHUB_TOKEN') ?? fail('GITHUB_TOKEN is not set');
  const api = setting('GITHUB_API_URL') ?? 'https://api.github.com';
  const response = await fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (response.ok) return (await response.json()) as unknown;
  console.error(`deploy-notice  GitHub answered ${response.status} to GET ${path}: the notice goes without its pull requests. Give the job pull-requests: read.`);
  return null;
}

async function statusesOf(config: Config, id: number): Promise<DeploymentStatus[]> {
  return list(await github(`/repos/${config.repo}/deployments/${id}/statuses?per_page=100`), 'the statuses of a deployment').map(toDeploymentStatus);
}

/** A deployment and the last final state Vercel reported for it, skipping the `inactive` GitHub sets once a newer one exists. */
async function loadDeployment(config: Config, id: number): Promise<DeploymentFacts> {
  const deployment = toDeployment(await github(`/repos/${config.repo}/deployments/${id}`));
  const final = (await statusesOf(config, id)).find((status) => buildOutcome(status.state) !== null);
  if (!final) fail(`deployment ${id} has no final status yet`);
  const url = final.environmentUrl ?? final.targetUrl ?? fail(`deployment ${id} has no URL`);
  return {
    id: deployment.id,
    sha: deployment.sha,
    githubEnvironment: deployment.environment,
    state: final.state,
    url,
    logs: final.logUrl ?? final.targetUrl,
    description: final.description,
  };
}

/** The last deployments of an environment, newest first. */
async function deploymentsOf(config: Config, githubEnvironment: string): Promise<Deployment[]> {
  const path = `/repos/${config.repo}/deployments?environment=${encodeURIComponent(githubEnvironment)}&per_page=30`;
  return list(await github(path), 'the deployments of an environment').map(toDeployment);
}

/**
 * The URL a deployment served when it succeeded, or `null` if it has not — yet,
 * or ever. Only a success is kept: it does not change once written, and the
 * waits below ask again every few seconds against a token that allows a
 * thousand calls an hour. A `null` is asked again, because a deployment still
 * building may succeed a moment later.
 */
const successUrls = new Map<number, string>();
async function successUrlOf(config: Config, id: number): Promise<string | null> {
  const known = successUrls.get(id);
  if (known !== undefined) return known;
  const success = (await statusesOf(config, id)).find((status) => status.state === 'success');
  const url = success?.environmentUrl ?? success?.targetUrl ?? null;
  if (url !== null) successUrls.set(id, url);
  return url;
}

/** Supabase's «Supabase Preview» run on a commit, if it created one yet. Only its own counts: any app could name a check the same. */
async function supabaseRunOf(config: Config, sha: string): Promise<CheckRun | undefined> {
  const answer = object(
    await github(`/repos/${config.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(config.supabaseCheck)}&filter=latest`),
    'the check runs of a commit',
  );
  return list(answer.check_runs, 'the check runs of a commit').map(toCheckRun).find((run) => run.app === 'supabase');
}

/** Supabase's verdict on a commit, the link to its check, and — when the check failed — at which step. */
async function waitForMigrations(config: Config, sha: string): Promise<{ outcome: 'applied' | 'failed' | 'stalled'; url?: string; step?: SupabaseStep }> {
  const deadline = Date.now() + config.migrationsWaitMinutes * 60_000;
  for (;;) {
    const run = await supabaseRunOf(config, sha);
    const outcome = migrationsOutcome(run);
    const url = run?.htmlUrl ?? undefined;
    if (outcome === 'failed') return { outcome, url, step: failedSupabaseStep(run?.summary) };
    if (outcome !== 'pending') return { outcome, url };
    if (Date.now() >= deadline) return { outcome: 'stalled', url };
    await sleep(MIGRATIONS_POLL_MS);
  }
}

/**
 * Vercel's latest word on a commit: its «Vercel» commit status, which says
 * «Waiting for checks to complete» while production waits and «Deployment has
 * completed» once published. GitHub lists statuses newest first, and only the
 * ones Vercel wrote count.
 */
async function vercelStatusOf(config: Config, sha: string): Promise<CommitStatus | undefined> {
  const statuses = list(await github(`/repos/${config.repo}/commits/${sha}/statuses?per_page=100`), 'the statuses of a commit').map(toCommitStatus);
  return statuses.find((status) => status.context === 'Vercel' && status.creator === 'vercel[bot]');
}

async function waitForPublication(config: Config, sha: string): Promise<{ outcome: 'published' | 'failed' | 'pending'; url?: string }> {
  const deadline = Date.now() + PUBLISH_WAIT_MINUTES * 60_000;
  for (;;) {
    const status = await vercelStatusOf(config, sha);
    const outcome = publicationOutcome(status?.state);
    const url = status?.targetUrl ?? undefined;
    if (outcome !== 'pending' || Date.now() >= deadline) return { outcome, url };
    await sleep(SERVED_POLL_MS);
  }
}

/**
 * The deployment an origin serves right now, or `null` when it cannot be read.
 * Asks the probe page as a navigation, which answers with the id in a header;
 * the page's own stamp is the fallback. Only Vercel URLs and the project's
 * domains are fetched.
 */
async function markerAt(config: Config, url: string): Promise<string | null> {
  const origin = new URL(url);
  const known =
    origin.hostname.endsWith('.vercel.app') ||
    Object.values(config.domains).some((domain) => domain !== null && new URL(domain).hostname === origin.hostname);
  if (!known) fail(`refusing to fetch ${url}: not a Vercel deployment nor one of the project's domains`);
  const page = new URL(config.probePath, origin);
  try {
    const navigation = await fetch(page, { headers: { rsc: '1', 'cache-control': 'no-cache' } });
    const header = navigation.headers.get('x-nextjs-deployment-id');
    if (navigation.ok && header?.startsWith('dpl_')) return header;
    const response = await fetch(page, { headers: { 'cache-control': 'no-cache' } });
    return response.ok ? deploymentMarker(await response.text()) : null;
  } catch {
    return null;
  }
}

async function waitUntilServed(config: Config, deployment: DeploymentFacts, domain: string): Promise<boolean> {
  let ours: string | null = null;
  for (let attempt = 1; attempt <= 3 && ours === null; attempt += 1) {
    ours = await markerAt(config, deployment.url);
    if (ours === null) await sleep(5_000);
  }
  if (ours === null) fail(`could not read which deployment ${deployment.url} serves: is skew protection on in Vercel, and does ${config.probePath} answer?`);

  // Which deployment each later deploy of the environment serves, once known.
  const newerMarkers = new Map<number, string>();
  const deadline = Date.now() + SERVED_WAIT_MINUTES * 60_000;
  for (;;) {
    const current = await markerAt(config, domain);
    if (current === ours) return true;
    if (current !== null) {
      // The domain may already serve a later deploy of the same environment, which contains this one.
      for (const later of (await deploymentsOf(config, deployment.githubEnvironment)).filter((d) => d.id > deployment.id)) {
        if (!newerMarkers.has(later.id)) {
          const url = await successUrlOf(config, later.id);
          const marker = url === null ? null : await markerAt(config, url);
          if (marker !== null) newerMarkers.set(later.id, marker);
        }
        if (newerMarkers.get(later.id) === current) return true;
      }
    }
    if (Date.now() >= deadline) return false;
    await sleep(SERVED_POLL_MS);
  }
}

/** Whether Vercel built a deployment — published it, or held it back — from the last final status it reported. */
async function wasBuilt(config: Config, id: number): Promise<boolean> {
  const final = (await statusesOf(config, id)).find((status) => buildOutcome(status.state) !== null);
  return final !== undefined && builtByVercel(final);
}

/**
 * What this deploy brought since the previous one of the same environment that
 * Vercel built: published, or held back by the migrations check. GitHub never
 * hears of a release published by hand, so a held one counts as the previous
 * one either way: the release after it lists only its own pull requests, and
 * if nobody published the held one, its pull requests reach the domain with
 * this one, unlisted.
 */
async function pullRequestsSince(config: Config, deployment: DeploymentFacts, change: PullRequest | null): Promise<PullRequest[]> {
  let previous: Deployment | undefined;
  for (const candidate of (await deploymentsOf(config, deployment.githubEnvironment)).filter((d) => d.id < deployment.id)) {
    if (await wasBuilt(config, candidate.id)) {
      previous = candidate;
      break;
    }
  }
  if (!previous) return change === null ? [] : [change];
  if (previous.sha === deployment.sha) return [];
  const comparison = object(await github(`/repos/${config.repo}/compare/${previous.sha}...${deployment.sha}`), 'a comparison');
  // Releases and syncs are merge commits; what they carry are the squashed commits inside.
  const subjects = list(comparison.commits, 'the commits of a comparison').flatMap((raw) => {
    const commit = object(raw, 'a commit');
    const parents = list(commit.parents, 'the parents of a commit');
    return parents.length === 1 ? [subjectOf(text(object(commit.commit, 'a commit').message, 'a commit'))] : [];
  });
  return pullRequestsIn(subjects);
}

/**
 * The pull request that made a commit, from GitHub rather than from the
 * commit's text: a merge commit may carry the pull request's title instead of
 * «Merge pull request #N from …», as ECO's release #12 did. `null` for a
 * commit pushed without one.
 */
async function pullRequestOf(config: Config, sha: string): Promise<(PullRequest & { base: string; head: string }) | null> {
  const answer = await githubIfAllowed(`/repos/${config.repo}/commits/${sha}/pulls`);
  if (answer === null) return null;
  const pulls = list(answer, 'the pull requests of a commit').map((raw) => object(raw, 'a pull request'));
  const merged = pulls.filter((pr) => typeof pr.merged_at === 'string');
  const pr = merged.find((candidate) => candidate.merge_commit_sha === sha) ?? merged[0];
  if (pr === undefined || typeof pr.number !== 'number') return null;
  const ref = (side: unknown) => (typeof side === 'object' && side !== null ? maybeText((side as Record<string, unknown>).ref) : null) ?? '';
  return { number: pr.number, title: text(pr.title, 'a pull request'), base: ref(pr.base), head: ref(pr.head) };
}

/** The change behind a commit, and whether it is a release: the pull request from the test branch into the release branch. */
async function changeOf(config: Config, sha: string): Promise<{ change: PullRequest | null; release: boolean }> {
  const pr = await pullRequestOf(config, sha);
  if (pr === null) return { change: null, release: false };
  return { change: { number: pr.number, title: pr.title }, release: pr.base === config.releaseBranch && pr.head === config.testBranch };
}

function summarize(kind: NoticeKind, message: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `### Deploy notice: \`${kind}\`\n\n\`\`\`\n${message}\n\`\`\`\n`);
}

/** What a commit says of itself, and where this run can be found, for the notice's links. */
async function commitFacts(config: Config, sha: string): Promise<{ subject: string; url: string; run: string }> {
  const server = setting('GITHUB_SERVER_URL') ?? 'https://github.com';
  const url = `${server}/${config.repo}/commit/${sha}`;
  const message = text(object(object(await github(`/repos/${config.repo}/commits/${sha}`), 'a commit').commit, 'a commit').message, 'a commit');
  const runId = setting('GITHUB_RUN_ID');
  const run = runId ? `${server}/${config.repo}/actions/runs/${runId}` : url;
  return { subject: subjectOf(message), url, run };
}

/** Prints the notice, adds it to the run's summary, and posts it — unless it is a dry run. */
async function deliver(notice: Notice, dryRun: boolean): Promise<void> {
  const message = renderNotice(notice);
  console.log(plainText(message));
  summarize(notice.kind, plainText(message));
  if (process.argv.includes('--payload')) console.log(`\n${JSON.stringify(payload(message), null, 2)}`);
  if (dryRun) {
    console.log('\ndeploy-notice  dry run: nothing was posted');
    return;
  }
  await postToSlack(process.env.SLACK_WEBHOOK_URL, message);
  console.log('\ndeploy-notice ✓  posted to Slack');
}

async function notifyDeployment(config: Config, id: number, statusId: number | null, dryRun: boolean): Promise<void> {
  if (statusId !== null && repeatsEarlierStatus(await statusesOf(config, id), statusId)) {
    console.log(`deploy-notice  deployment ${id} already reported this state: it was told then`);
    return;
  }
  const deployment = await loadDeployment(config, id);
  const environment = environmentOf(deployment.githubEnvironment, config.environments);
  const domain = environment === null ? null : config.domains[environment];
  if (environment === null || domain === null) {
    console.log(`deploy-notice  deployment ${id} is a ${deployment.githubEnvironment} one: nothing to tell`);
    return;
  }
  const commit = await commitFacts(config, deployment.sha);
  const { change, release } = await changeOf(config, deployment.sha);

  let kind: NoticeKind;
  let migrations: string | undefined;
  let supabaseStep: SupabaseStep | undefined;
  let waitedMinutes: number | undefined;
  let pullRequests: PullRequest[] = [];

  if (buildOutcome(deployment.state) === 'failed') {
    const migrationsNow = environment === 'production' ? migrationsOutcome(await supabaseRunOf(config, deployment.sha)) : 'pending';
    if (leftToReleaseWatch(environment, migrationsNow)) {
      console.log(`deploy-notice  deployment ${id} failed along with Supabase's check on its commit: the release watch tells`);
      return;
    }
    kind = 'build-failed';
  } else {
    const result = await waitForMigrations(config, deployment.sha);
    migrations = result.url;
    if (result.outcome === 'failed') {
      kind = 'supabase-failed';
      supabaseStep = result.step;
    } else if (result.outcome === 'stalled') {
      kind = 'migrations-stalled';
      waitedMinutes = config.migrationsWaitMinutes;
    } else if (await waitUntilServed(config, deployment, domain)) {
      kind = 'live';
      const gate = config.testBranch;
      const token = setting('GITHUB_TOKEN') ?? '';
      const brought =
        release && change !== null
          ? await pullRequestsOfRelease(config.repo, change.number, gate, token).catch((error: unknown) => {
              console.error(`deploy-notice  ${error instanceof Error ? error.message : String(error)}: the release lists the commits since the previous one instead`);
              return null;
            })
          : null;
      pullRequests = brought?.map((pr) => ({ number: pr.number, title: pr.title })) ?? (await pullRequestsSince(config, deployment, change));
    } else {
      kind = 'not-served';
      waitedMinutes = SERVED_WAIT_MINUTES;
    }
  }

  await deliver(
    {
      project: config.project,
      kind,
      environment,
      testName: config.testBranch,
      repoUrl: config.repoUrl,
      commit: { sha: deployment.sha, subject: commit.subject, url: commit.url },
      change,
      release,
      pullRequests,
      links: { site: domain, deployment: deployment.url, logs: deployment.logs ?? undefined, migrations, run: commit.run },
      supabaseStep,
      waitedMinutes,
      vercelSays: kind === 'build-failed' ? (deployment.description ?? undefined) : undefined,
    },
    dryRun,
  );
}

/**
 * The release watch: a merge to the release branch, followed until production
 * either took it or showed why it did not. It stays quiet when the deploy
 * notice will speak, and when a newer release took over.
 */
async function watchRelease(config: Config, sha: string, dryRun: boolean): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`${sha} is not a full commit SHA`);
  const commit = await commitFacts(config, sha);
  const { change, release } = await changeOf(config, sha);
  const migrations = await waitForMigrations(config, sha);

  let publication: 'published' | 'failed' | 'pending' = 'pending';
  let deployment: string | undefined;
  let superseded = false;
  if (migrations.outcome === 'applied') {
    ({ outcome: publication, url: deployment } = await waitForPublication(config, sha));
    if (publication === 'pending') {
      const branch = object(await github(`/repos/${config.repo}/branches/${encodeURIComponent(config.releaseBranch)}`), 'a branch');
      superseded = text(object(branch.commit, 'a branch').sha, 'a branch') !== sha;
    }
  } else {
    deployment = (await vercelStatusOf(config, sha))?.targetUrl ?? undefined;
  }

  const kind = releaseNotice(migrations.outcome, publication, superseded);
  if (kind === null) {
    const why = superseded ? 'a newer release took over' : publication === 'published' ? 'published' : 'the build failed';
    console.log(`deploy-notice  release ${sha.slice(0, 7)}: ${why}, and the deploy notice tells what it has to`);
    return;
  }
  await deliver(
    {
      project: config.project,
      kind,
      environment: 'production',
      testName: config.testBranch,
      repoUrl: config.repoUrl,
      commit: { sha, subject: commit.subject, url: commit.url },
      change,
      release,
      pullRequests: [],
      links: { site: config.domains.production ?? commit.url, deployment: deployment ?? commit.url, migrations: migrations.url, run: commit.run },
      supabaseStep: migrations.step,
      waitedMinutes: kind === 'migrations-stalled' ? config.migrationsWaitMinutes : kind === 'not-served' ? PUBLISH_WAIT_MINUTES : undefined,
    },
    dryRun,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      deployment: { type: 'string' },
      release: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      payload: { type: 'boolean', default: false },
    },
  });
  const config = configure(values.repo);
  const dryRun = values['dry-run'] === true || setting('DRY_RUN') === 'true';

  const release = values.release ?? setting('RELEASE_SHA');
  if (release) return watchRelease(config, release, dryRun);

  const id = Number(values.deployment ?? setting('DEPLOYMENT_ID'));
  if (!Number.isInteger(id) || id <= 0) fail('which deploy? Pass --deployment <id> or --release <sha>, or set DEPLOYMENT_ID or RELEASE_SHA.');
  // The status that started the run; none when a person asked for the notice again.
  const statusId = Number(setting('DEPLOYMENT_STATUS_ID') ?? NaN);
  return notifyDeployment(config, id, Number.isInteger(statusId) ? statusId : null, dryRun);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
