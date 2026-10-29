/**
 * What the health watch tells Slack: a project's `/api/health` read every
 * half hour, a message when a check starts failing, a reminder every 6 hours
 * while it keeps failing, and one more when it works again. Pure: `watch.ts`
 * fetches, posts and keeps the state.
 *
 * The route is the project's, and it answers one of two ways:
 *
 *   200 {"status":"ok"}
 *   503 {"status":"failing","failing":[{"code":"queue_stuck","since":"2026-10-27T15:05:00.000Z"}]}
 *
 * `since` is optional. Anything else — another status, a body that is not the
 * report, no answer at all — is production not answering, and that is a
 * failure of its own, `unreachable`. The words for each code are the
 * project's, in a file of its own; what the message carries is the codes,
 * since when, and where the detail is, never data.
 */

import { escape, link, titled, type Field, type Message } from '../lib/slack.ts';

/** The watch's own code: the route did not answer, or not with its report. */
export const UNREACHABLE = 'unreachable';

/** What a code looks like: the words of the message may quote it, so nothing else gets through. */
const CODE = /^[a-z_]{1,60}$/;

export interface FailingCheck {
  code: string;
  /** When it started failing, as the route says it; null when nothing says. */
  since: string | null;
}

/** What one read of the route said. */
export type HealthRead = { kind: 'ok' } | { kind: 'failing'; failing: FailingCheck[] };

/** The route's answer, as the watch takes it. */
export function readHealth(status: number | null, body: unknown): HealthRead {
  const unreachable: HealthRead = { kind: 'failing', failing: [{ code: UNREACHABLE, since: null }] };
  if (status === null || typeof body !== 'object' || body === null) return unreachable;
  const report = body as { status?: unknown; failing?: unknown };
  if (status === 200 && report.status === 'ok') return { kind: 'ok' };
  if (status !== 503 || report.status !== 'failing' || !Array.isArray(report.failing)) return unreachable;
  const failing = report.failing.flatMap((entry: unknown): FailingCheck[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { code, since } = entry as { code?: unknown; since?: unknown };
    return typeof code === 'string' && CODE.test(code) ? [{ code, since: typeof since === 'string' ? since : null }] : [];
  });
  return failing.length === 0 ? unreachable : { kind: 'failing', failing };
}

/**
 * The project's words for its codes, from its checks file: an object of code
 * to one sentence. Throws on anything else, so a broken file fails the run
 * instead of turning every alert into codes nobody explained.
 */
export function readChecks(raw: unknown): Readonly<Record<string, string>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('the checks file is not an object of code to words');
  const words: Record<string, string> = {};
  for (const [code, sentence] of Object.entries(raw)) {
    if (!CODE.test(code)) throw new Error(`"${code}" is not a code: lowercase letters and underscores, up to 60`);
    if (typeof sentence !== 'string' || sentence.trim() === '') throw new Error(`the code ${code} has no words`);
    words[code] = sentence.trim();
  }
  return words;
}

/** What the watch remembers between runs: when it last told Slack of each code that is failing. */
export interface WatchState {
  told: Record<string, string>;
}

export const EMPTY_STATE: WatchState = { told: {} };

/** How often a check that keeps failing is told again. */
export const REMIND_AFTER_MS = 6 * 60 * 60_000;

/** The state as the cache brought it back, or empty when there is none or it is not one. */
export function readState(raw: unknown): WatchState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_STATE;
  const told = (raw as { told?: unknown }).told;
  if (typeof told !== 'object' || told === null) return EMPTY_STATE;
  const entries = Object.entries(told).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !Number.isNaN(Date.parse(entry[1])));
  return { told: Object.fromEntries(entries) };
}

export interface Decision {
  /** Failing now, and not when the watch last looked. */
  started: FailingCheck[];
  /** Still failing, told 6 hours ago or more. */
  reminded: FailingCheck[];
  /** Told as failing before, and not failing now. */
  recovered: string[];
  /** What to remember for the next run: a code that stopped failing is forgotten, so failing again is news. */
  next: WatchState;
}

export function decide(read: HealthRead, state: WatchState, now: Date): Decision {
  const failing = read.kind === 'ok' ? [] : read.failing;
  const started: FailingCheck[] = [];
  const reminded: FailingCheck[] = [];
  const told: Record<string, string> = {};
  for (const check of failing) {
    const last = state.told[check.code];
    if (last === undefined) {
      started.push(check);
      told[check.code] = now.toISOString();
    } else if (now.getTime() - Date.parse(last) >= REMIND_AFTER_MS) {
      reminded.push(check);
      told[check.code] = now.toISOString();
    } else {
      told[check.code] = last;
    }
  }
  const recovered = Object.keys(state.told).filter((code) => !(code in told));
  return { started, reminded, recovered, next: { told } };
}

/** Everything a message needs besides what failed. */
export interface Context {
  project: string;
  /** The origin the watch read, such as https://example.com. */
  origin: string;
  healthPath: string;
  /** The project's words for its codes. */
  words: Readonly<Record<string, string>>;
  /** Where the detail is, behind the project's session, such as /diagnostics; null when the project has none. */
  detailsPath: string | null;
  /** The zone the times are told in, such as America/Mexico_City. */
  timeZone: string;
}

/** A check in words, for a row's label: `queue_stuck` → «Queue stuck». */
export function checkName(code: string): string {
  if (code === UNREACHABLE) return 'Production does not answer';
  const words = code.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** When a check started failing, in the project's time zone: the time alone today, the day too before. */
function sinceText(since: string | null, context: Context, now: Date): string | null {
  if (since === null || Number.isNaN(Date.parse(since))) return null;
  const date = new Date(since);
  const day = (moment: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: context.timeZone }).format(moment);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: context.timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
  if (day(date) === day(now)) return time;
  return `${new Intl.DateTimeFormat('en-US', { timeZone: context.timeZone, month: 'short', day: 'numeric' }).format(date)}, ${time}`;
}

/** One check, one row: its name, and since when and what it means. */
function row(check: FailingCheck, context: Context, now: Date): Field {
  const words =
    context.words[check.code] ??
    (check.code === UNREACHABLE ? `${context.healthPath} did not respond as it should.` : 'A check this watch does not know.');
  const since = sinceText(check.since, context, now);
  return { label: checkName(check.code), value: since === null ? escape(words) : `Since ${escape(since)} · ${escape(words)}` };
}

const problems = (count: number) => (count === 1 ? 'a problem' : `${count} problems`);

function detailsLink(context: Context): string[] {
  return context.detailsPath === null ? [] : [link(`${context.origin}${context.detailsPath}`, 'Open diagnostics')];
}

/** What a test posts: proof that a message reaches the channel, saying it is one. */
export function testMessage(project: string): Message {
  return {
    title: titled(project, 'health watch test'),
    tone: 'ready',
    note: 'This is how an alert reaches this channel. Nothing is failing.',
  };
}

/**
 * The message, or null when there is nothing to tell: what fails, new first,
 * a row each; or, when nothing new fails or is due a reminder, what works
 * again.
 */
export function alertMessage(decision: Decision, context: Context, now: Date): Message | null {
  const failing = [...decision.started, ...decision.reminded];
  const workingAgain = decision.recovered.map((code): Field => ({ label: checkName(code), value: '✅ Fixed' }));
  if (failing.length > 0) {
    return {
      title: titled(context.project, decision.started.length > 0 ? `production has ${problems(failing.length)}` : `production still has ${problems(failing.length)}`),
      tone: 'warning',
      fields: [...failing.map((check) => row(check, context, now)), ...workingAgain],
      footer: ['Reminder every 6 h while it fails', ...detailsLink(context)],
    };
  }
  if (workingAgain.length > 0) {
    // What still fails was told already, and is due no reminder yet; it is named, not told again.
    const still = Object.keys(decision.next.told).map(checkName);
    return {
      title: titled(context.project, still.length === 0 ? 'production is back to normal' : `${workingAgain.length === 1 ? 'a problem is' : `${workingAgain.length} problems are`} fixed in production`),
      tone: 'good',
      fields: still.length === 0 ? workingAgain : [...workingAgain, { label: 'Still failing', value: escape(still.join(', ')) }],
      footer: [link(context.origin, 'Open production'), ...detailsLink(context)],
    };
  }
  return null;
}
