/**
 * What Slack hears about a deploy of `test` or production, for a project on
 * Vercel and Supabase.
 *
 * Every release is published by two systems that do not wait for each other:
 * Vercel builds the code and Supabase applies the migrations. Production may
 * wait for Supabase before it takes the new version — a Vercel Deployment
 * Check on «Supabase Preview» — and `test` usually does not need to, because
 * its migrations land within seconds. Either way somebody has to hear when a
 * deploy failed, got stuck or went live, without opening three dashboards.
 * This module decides which notice a deploy earns and writes it; `notify.ts`
 * asks the questions and posts the answer.
 *
 * Two paths ask. The deploy notice starts when Vercel reports a deployment to
 * GitHub, which for `test` is the end of the build — and for a production that
 * waits for its migrations, only the end of the wait, when Vercel publishes it
 * or holds it back. So a release whose wait never ends would never reach it,
 * and the release watch covers that: it starts with the merge to the release
 * branch and speaks only for what the deploy notice cannot.
 */

import { summaryOf } from '../lib/conventional.ts';
import { escape, link, titled, type Field, type Message, type Step } from '../lib/slack.ts';

export type DeployEnvironment = 'production' | 'test';

/** The GitHub environments Vercel reports each of ours under; a project without `test` has none. */
export interface EnvironmentNames {
  production: string;
  test: string | null;
}

/** The GitHub environment Vercel reports a deployment under, as ours. Previews are nobody's business here. */
export function environmentOf(githubEnvironment: string, names: EnvironmentNames): DeployEnvironment | null {
  if (githubEnvironment === names.production) return 'production';
  if (names.test !== null && githubEnvironment === names.test) return 'test';
  return null;
}

/** Vercel's verdict on the build, from the state of its deployment status; `null` for a state that is not final. */
export function buildOutcome(state: string): 'ready' | 'failed' | null {
  if (state === 'success') return 'ready';
  if (state === 'failure' || state === 'error') return 'failed';
  return null;
}

/**
 * Whether a final status repeats one the deployment already had. Vercel may
 * report a deployment twice — Control Tower's 7425348273 got two `success`,
 * 69 seconds apart — and each report starts a run, so only the first of each
 * state is news. A different state is: a held release published later.
 */
export function repeatsEarlierStatus(statuses: readonly { id: number; state: string }[], statusId: number): boolean {
  const current = statuses.find((status) => status.id === statusId);
  if (current === undefined || buildOutcome(current.state) === null) return false;
  return statuses.some((status) => status.id < statusId && status.state === current.state);
}

/**
 * Whether Vercel built a deployment, from the last final status it reported:
 * it published it, or it held it back because production's migrations check
 * failed. Vercel reports the second as a `failure` too, and only its
 * description tells it from a build that failed. A held release may have been
 * published by hand afterwards, which GitHub never hears of.
 */
export function builtByVercel(status: { state: string; description?: string | null }): boolean {
  if (status.state === 'success') return true;
  return status.state === 'failure' && (status.description?.startsWith('Checks for Deployment') ?? false);
}

/**
 * Supabase's verdict on the migrations of a commit, from its «Supabase
 * Preview» check run. A run that has not finished — or has not been created
 * yet — is `pending`: the caller keeps asking. A skipped or neutral run means
 * there was nothing to apply, which is as good as applied. A failed run may
 * have failed after the migrations: `failedSupabaseStep` tells.
 */
export function migrationsOutcome(
  run: { status: string; conclusion: string | null } | undefined,
): 'pending' | 'applied' | 'failed' {
  if (run === undefined || run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped') return 'applied';
  return 'failed';
}

/** The step that failed «Supabase Preview», as far as its summary tells. */
export type SupabaseStep = 'migrations' | 'buckets' | 'unknown';

/**
 * Signs of each step in the summary, strongest first: Postgres names every SQL
 * error with its SQLSTATE, and Storage an object over its limit EntityTooLarge,
 * so either decides before any word does.
 */
const STEP_SIGNS: [RegExp, Exclude<SupabaseStep, 'unknown'>][] = [
  [/\bSQLSTATE\b/, 'migrations'],
  [/\bEntityTooLarge\b/, 'buckets'],
  [/\bmigrations?\b/i, 'migrations'],
  [/\bbuckets?\b/i, 'buckets'],
];

/**
 * Which step failed a «Supabase Preview» check, read from its summary — the
 * one account a workflow can read, since it holds no Supabase key. Supabase
 * applies the migrations first and the buckets of `supabase/config.toml`
 * after, so failed buckets mean the migrations landed: in a release of Control
 * Tower on 14 October 2026 Storage refused a bucket, and the migrations were
 * all there. Anything else is `unknown`, and the notice says nothing of the
 * migrations.
 */
export function failedSupabaseStep(summary: string | null | undefined): SupabaseStep {
  return STEP_SIGNS.find(([sign]) => sign.test(summary ?? ''))?.[1] ?? 'unknown';
}

/**
 * Vercel's word on a commit, from the state of its «Vercel» commit status:
 * `published` once the deployment took its domains, `failed` when it will not,
 * and `pending` while it builds or — in production — waits for the migrations
 * check, which Vercel describes as «Waiting for checks to complete».
 */
export function publicationOutcome(state: string | undefined): 'published' | 'failed' | 'pending' {
  if (state === 'success') return 'published';
  if (state === 'failure' || state === 'error') return 'failed';
  return 'pending';
}

/**
 * What the release watch says about a release, or `null` for silence. It
 * speaks for what the deploy notice cannot reach: a Supabase check that failed
 * or stalled, and a database that is ready while Vercel still did not publish.
 * A published release is the deploy notice's «✅», a failed build its «🚨
 * Deploy failed», and a release a newer one took over is nobody's alert.
 */
export function releaseNotice(
  migrations: 'applied' | 'failed' | 'stalled',
  publication: 'published' | 'failed' | 'pending',
  superseded: boolean,
): NoticeKind | null {
  if (migrations === 'failed') return 'supabase-failed';
  if (migrations === 'stalled') return 'migrations-stalled';
  if (publication === 'pending' && !superseded) return 'not-served';
  return null;
}

/**
 * Whether a failed production deployment is the release watch's to tell. When
 * Supabase's check failed on the same commit, what failed in Vercel is the
 * check that waited for it, not the build: the release watch says which step
 * of Supabase failed, and one alert is enough.
 */
export function leftToReleaseWatch(environment: DeployEnvironment, migrations: 'pending' | 'applied' | 'failed'): boolean {
  return environment === 'production' && migrations === 'failed';
}

/**
 * Which deployment a page was served by. With skew protection on, Next stamps
 * the id of the deployment on every page (`<html data-dpl-id="dpl_…">`) and on
 * every navigation response (`x-nextjs-deployment-id`), so a domain and a
 * deployment's own URL agree exactly when the domain serves that deployment.
 * This reads the page; `notify.ts` tries the header first.
 */
export function deploymentMarker(html: string): string | null {
  return /<html\b[^>]*\bdata-dpl-id="(dpl_[A-Za-z0-9]+)"/.exec(html)?.[1] ?? null;
}

export interface PullRequest {
  number: number;
  title: string;
}

/**
 * The pull requests a range of commits brought, read from their subjects:
 * every change is squashed into «<title> (#<number>)». Merge commits —
 * releases, syncs — are the caller's to leave out, and a subject without a
 * number is not a pull request.
 */
export function pullRequestsIn(subjects: string[]): PullRequest[] {
  const found = new Map<number, PullRequest>();
  for (const subject of subjects) {
    const match = /^(.*\S)\s+\(#(\d+)\)$/.exec(subject.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) found.set(Number(match[2]), { number: Number(match[2]), title: match[1] });
  }
  return [...found.values()].sort((a, b) => a.number - b.number);
}

/** Every outcome a deploy of `test` or production can end in. */
export type NoticeKind =
  /** Vercel could not build it; the previous version is still live. */
  | 'build-failed'
  /** Supabase failed its check on this commit; `supabaseStep` says at which step. */
  | 'supabase-failed'
  /** Supabase did not finish within the wait. */
  | 'migrations-stalled'
  /** The migrations landed, and the domain still serves another deployment. */
  | 'not-served'
  /** The domain serves this deployment, or a newer one that contains it. */
  | 'live';

export interface Notice {
  /** The project's name, which starts the message. */
  project: string;
  kind: NoticeKind;
  environment: DeployEnvironment;
  /** What messages call `test`: the branch it deploys from, such as `test` or `staging`. */
  testName: string;
  /** The repo on GitHub, `https://github.com/<owner>/<name>`, where pull request links start. */
  repoUrl: string;
  /** The commit, and its subject for when no pull request made it. */
  commit: { sha: string; subject: string; url: string };
  /** The pull request that made the commit: a task, an umbrella, a hotfix, or a release. */
  change: PullRequest | null;
  /** Whether `change` is a release, the gate → the release branch. */
  release: boolean;
  /** What the deploy brought: a release's pull requests, or the ones since the previous deploy. Read for `live`. */
  pullRequests: PullRequest[];
  links: {
    /** The environment's domain. */
    site: string;
    /** The deployment's own URL on Vercel. */
    deployment: string;
    /** Where Vercel's build logs are; only for `build-failed`. */
    logs?: string;
    /** The «Supabase Preview» check run; for the migrations notices. */
    migrations?: string;
    /** The workflow run that wrote this, for when something in it looks wrong. */
    run: string;
  };
  /** Which step of Supabase failed, for `supabase-failed`; `unknown` when absent. */
  supabaseStep?: SupabaseStep;
  /** How long the wait lasted, for `migrations-stalled` and `not-served`. */
  waitedMinutes?: number;
  /** What Vercel said about a failed build — it names the command that prints its logs. */
  vercelSays?: string;
}

const done = (label: string): Step => ({ state: 'done', label });
const failed = (label: string): Step => ({ state: 'failed', label });

/** What happened and what to do about it, for a notice that is not good news. */
interface Trouble {
  title: string;
  steps: Step[];
  happened: string;
  todo: string;
  /** Where the failure shows. */
  look: { url: string; label: string };
}

function trouble(notice: Notice): Trouble {
  const production = notice.environment === 'production';
  const place = production ? 'production' : notice.testName;
  const named = production ? 'production' : `\`${notice.testName}\``;
  const waited = notice.waitedMinutes ?? '?';
  // Production waits for its migrations before it takes a version; `test` takes it at once.
  const site: Step = production ? { state: 'held', label: 'Site held back' } : done('Site live');
  const held = 'Production is still on the previous version.';
  const check = { url: notice.links.migrations ?? notice.links.run, label: "Supabase's check" };

  switch (notice.kind) {
    case 'build-failed':
      return {
        title: `the ${place} build failed`,
        steps: [failed('Code built'), { state: 'held', label: 'Site held back' }],
        happened: `Vercel could not build this version, so ${named} is still on the previous one.${notice.vercelSays ? ` Vercel: ${escape(notice.vercelSays)}` : ''}`,
        todo: 'Read the build log, fix the error in a new pull request, and merge it.',
        look: { url: notice.links.logs ?? notice.links.deployment, label: 'Build log in Vercel' },
      };

    case 'supabase-failed':
      switch (notice.supabaseStep ?? 'unknown') {
        case 'migrations':
          return {
            title: `the ${place} database update failed`,
            steps: [done('Code built'), failed('Database updated'), site],
            happened: production
              ? `Supabase could not apply this commit's migrations, and Vercel did not publish. ${held}`
              : `Supabase could not apply the migrations, and the new code is already live in ${named}: it may fail wherever it uses the new schema.`,
            todo: "Open Supabase's check to see which migration failed, and fix it in a new pull request.",
            look: check,
          };
        case 'buckets':
          return {
            title: `the ${place} storage buckets failed`,
            steps: [done('Code built'), done('Database updated'), failed('Storage buckets'), site],
            happened: production
              ? `Supabase applied the migrations, but not the buckets in \`supabase/config.toml\`, and Vercel did not publish. ${held}`
              : `Supabase applied the migrations, but not the buckets in \`supabase/config.toml\`. The new code is already live in ${named}: it may fail wherever it uses them.`,
            todo: production
              ? "Open Supabase's check. Once the buckets fit production's storage limit, publish the held deployment in Vercel."
              : "Open Supabase's check, and fix the buckets in a new pull request.",
            look: check,
          };
        case 'unknown':
          return {
            title: `Supabase's check failed for ${place}`,
            steps: [done('Code built'), failed("Supabase's check"), site],
            happened: production
              ? `A step this notice does not know failed, so it cannot tell whether the migrations were applied. ${held}`
              : `A step this notice does not know failed, so it cannot tell whether the migrations were applied. The new code is already live in ${named}.`,
            todo: "Open Supabase's check to see which step failed.",
            look: check,
          };
      }
      break;

    case 'migrations-stalled':
      return {
        title: production ? 'production deploy is stuck' : `${place} is waiting for its database`,
        steps: [done('Code built'), { state: 'waiting', label: 'Database updating' }, site],
        happened: production
          ? `Supabase has not finished the migrations after ${waited} minutes, and Vercel does not publish until it does. ${held}`
          : `Supabase has not finished the migrations after ${waited} minutes, and the new code is already live in ${named}.`,
        todo: production
          ? "Open Supabase's check. If it is urgent and the new code does not need those migrations, «Force Promote» the deployment in Vercel."
          : "Open Supabase's check to see where it stopped.",
        look: notice.links.migrations ? check : { url: notice.links.deployment, label: 'The deployment in Vercel' },
      };

    case 'not-served':
      return {
        title: `${place} did not go live`,
        steps: [done('Code built'), done('Database updated'), failed('Site live')],
        happened: `The migrations finished, but ${waited} minutes later the domain of ${named} still serves another version.`,
        todo: 'Open the deployment in Vercel and check that it took the domain.',
        look: { url: notice.links.deployment, label: 'The deployment in Vercel' },
      };

    case 'live':
      break;
  }
  throw new Error(`${notice.kind} is not trouble`);
}

function pullRequestUrl(notice: Notice, number: number): string {
  return `${notice.repoUrl}/pull/${number}`;
}

/** The table's first row: the release or the change, and the commit. */
function changeFields(notice: Notice): Field[] {
  const change = notice.change;
  return [
    {
      label: notice.release ? 'Release' : 'Change',
      value: change === null ? escape(notice.commit.subject) : link(pullRequestUrl(notice, change.number), `#${change.number} ${summaryOf(change.title)}`),
    },
    { label: 'Commit', value: link(notice.commit.url, notice.commit.sha.slice(0, 7)) },
  ];
}

function whatsNew(notice: Notice): Message['list'] {
  return {
    label: `What's new (${notice.pullRequests.length})`,
    items: notice.pullRequests.map((pr) => `• ${link(pullRequestUrl(notice, pr.number), `#${pr.number}`)} ${escape(summaryOf(pr.title))}`),
  };
}

/** The message: a title, the steps, a table, and where to look. */
export function renderNotice(notice: Notice): Message {
  const production = notice.environment === 'production';

  if (notice.kind === 'live') {
    const message: Message = {
      title: titled(notice.project, production ? 'production updated' : `${notice.testName} is ready to try`),
      tone: production ? 'good' : 'ready',
      steps: [done('Code built'), done('Database updated'), done('Site live')],
      fields: changeFields(notice),
      footer: [link(notice.links.site, production ? 'Open production' : `Open ${notice.testName}`)],
    };
    // A release lists what it brought; anything else, only when it brought more than its own change.
    const own = notice.change !== null && notice.pullRequests.length === 1 && notice.pullRequests[0]?.number === notice.change.number;
    if (notice.release || (notice.pullRequests.length > 0 && !own)) message.list = whatsNew(notice);
    if (production && notice.pullRequests.length === 0 && !notice.release) message.note = 'Nothing new since the previous release: it is a redeploy.';
    return message;
  }

  const what = trouble(notice);
  return {
    title: titled(notice.project, what.title),
    tone: 'bad',
    steps: what.steps,
    fields: [{ label: 'What happened', value: what.happened }, { label: 'What to do', value: what.todo }, ...changeFields(notice)],
    footer: [link(what.look.url, what.look.label)],
  };
}
