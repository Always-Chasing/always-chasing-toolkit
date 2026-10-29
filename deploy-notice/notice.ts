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

import { escape, headed, link } from '../lib/slack.ts';

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
  commit: { sha: string; subject: string; url: string };
  /** What the pull requests since the previous deploy of the same environment were; only read for `live`. */
  pullRequests: PullRequest[];
  links: {
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

const PLACE: Record<DeployEnvironment, string> = { production: 'production', test: '`test`' };

function heading(notice: Notice, text: string): string {
  const short = notice.commit.sha.slice(0, 7);
  return headed(notice.project, `${text} — ${link(notice.commit.url, short)} ${escape(notice.commit.subject)}`);
}

function pullRequestLines(pullRequests: PullRequest[]): string[] {
  return pullRequests.map((pr) => `• #${pr.number} ${escape(pr.title)}`);
}

function brings(count: number): string {
  return count === 1 ? 'Brings 1 PR:' : `Brings ${count} PRs:`;
}

/** The message, in Slack's mrkdwn. */
export function renderNotice(notice: Notice): string {
  const place = PLACE[notice.environment];
  const production = notice.environment === 'production';
  const waited = notice.waitedMinutes ?? '?';
  const lines: string[] = [];

  switch (notice.kind) {
    case 'build-failed':
      lines.push(heading(notice, `🚨 *Deploy failed in ${place}*`));
      lines.push(`Vercel could not build this version; ${place} is still on the previous one.`);
      if (notice.vercelSays) lines.push(`Vercel: ${escape(notice.vercelSays)}`);
      lines.push(link(notice.links.logs ?? notice.links.deployment, 'The deployment on Vercel'));
      break;

    case 'supabase-failed': {
      const held = 'Vercel did not publish the new version: production is still on the previous one.';
      switch (notice.supabaseStep ?? 'unknown') {
        case 'migrations':
          lines.push(heading(notice, `🚨 *Migrations failed in ${place}*`));
          lines.push(
            production
              ? `Supabase could not apply this commit's migrations. ${held}`
              : 'Supabase could not apply them to the `test` database, and the new code is already live there: it may fail wherever it uses the new schema.',
          );
          break;
        case 'buckets':
          lines.push(heading(notice, `🚨 *Buckets failed in ${place}*`));
          lines.push(
            production
              ? `Supabase applied the migrations, but not the buckets in \`supabase/config.toml\`. ${held}`
              : 'Supabase applied the migrations to `test`, but not the buckets in `supabase/config.toml`. The new code is already live there: it may fail wherever it uses them.',
          );
          break;
        case 'unknown':
          lines.push(heading(notice, `🚨 *Supabase's check failed in ${place}*`));
          lines.push(
            production
              ? `The step that failed is not one this notice knows, so it cannot tell whether the migrations were applied. ${held}`
              : 'The step that failed is not one this notice knows, so it cannot tell whether the migrations of `test` were applied. The new code is already live there.',
          );
          break;
      }
      lines.push(link(notice.links.migrations ?? notice.links.run, "Supabase's check"));
      break;
    }

    case 'migrations-stalled':
      lines.push(heading(notice, production ? '🚨 *Production held back*' : '🚨 *`test` without its migrations*'));
      lines.push(
        production
          ? `Supabase has not finished the migrations after ${waited} minutes, and Vercel does not publish until it does: production is still on the previous version. If it is urgent and the new code does not depend on those migrations, «Force Promote» the deployment in Vercel.`
          : `Supabase has not finished the migrations of \`test\` after ${waited} minutes, and the new code is already live there.`,
      );
      lines.push(link(notice.links.migrations ?? notice.links.deployment, notice.links.migrations ? "Supabase's check" : 'The deployment'));
      break;

    case 'not-served':
      lines.push(heading(notice, `🚨 *${production ? 'Production' : '`test`'} was not published*`));
      lines.push(`The migrations finished, but ${waited} minutes later the domain of ${place} still serves another version. Check the deployment in Vercel.`);
      lines.push(link(notice.links.deployment, 'The deployment'));
      break;

    case 'live': {
      const count = notice.pullRequests.length;
      if (production) {
        lines.push(heading(notice, '✅ *Production published*'));
        if (count === 0) lines.push('Nothing new since the previous release: it is a redeploy.');
        else lines.push(brings(count), ...pullRequestLines(notice.pullRequests));
      } else {
        lines.push(heading(notice, '✅ *`test` ready*'));
        lines.push('The code and the database are both there: ready to try.');
        if (count > 1) lines.push(brings(count), ...pullRequestLines(notice.pullRequests));
      }
      break;
    }
  }

  return lines.join('\n');
}
