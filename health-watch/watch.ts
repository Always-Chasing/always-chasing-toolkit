/**
 * The health watch: reads a project's `/api/health`, tells Slack what started
 * failing, reminds every 6 hours what keeps failing, and says when it works
 * again. It runs as a GitHub workflow, outside what it watches, so it still
 * speaks when the whole application is down. The action (`action.yml`) runs it; on a laptop:
 *
 *   PROJECT=… PRODUCTION_URL=… node health-watch/watch.ts --checks <file> --dry-run [--url <origin>]
 *   SLACK_WEBHOOK_URL=… PROJECT=… node health-watch/watch.ts --test
 *
 * A dry run reads the given origin — production, one of `ALLOWED_URLS`, a
 * Vercel preview or the laptop — and prints what it would post — the message
 * of a check that starts failing, the 6-hour reminder of one that keeps
 * failing, and the one when it works again — without posting or remembering
 * anything; `--payload` adds what Slack would get. A test posts a message
 * that says it is a test, to see one reach the channel. Otherwise it watches
 * production, and only production. The action passes the mode as `MODE`, so
 * nothing a person types reaches the command line.
 *
 * Plain Node, no dependencies: a watch every half hour is 48 runs a day, each
 * billed by the minute. What it remembers between runs — when it last told
 * each code — is a file the action keeps in the Actions cache (`STATE_FILE`).
 * The one secret is the webhook, and nothing but `hooks.slack.com` is posted
 * to.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { payload, plainText, postToSlack, type Message } from '../lib/slack.ts';
import { alertMessage, decide, EMPTY_STATE, readChecks, readHealth, readState, REMIND_AFTER_MS, testMessage, type Context, type HealthRead } from './alert.ts';

/** What the route may take: a database answers in under a second, and a cold start in a few. */
const TIMEOUT_MS = 30_000;

function fail(message: string): never {
  console.error(`health-watch ✗  ${message}`);
  process.exit(1);
}

function setting(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';
  return value === '' ? null : value;
}

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    checks: { type: 'string' },
    state: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    test: { type: 'boolean', default: false },
    payload: { type: 'boolean', default: false },
  },
});
const requestedMode = setting('MODE');
if (requestedMode !== null && !['watch', 'dry-run', 'test'].includes(requestedMode)) fail(`MODE is watch, dry-run or test, not ${requestedMode}`);
const mode = values.test || requestedMode === 'test' ? 'test' : values['dry-run'] || requestedMode === 'dry-run' ? 'dry-run' : 'watch';
const project = setting('PROJECT') ?? fail('PROJECT is not set: every message starts with the project name');

try {
  if (mode === 'test') {
    await postToSlack(process.env.SLACK_WEBHOOK_URL, testMessage(project));
    console.log('health-watch ✓  posted a test alert to Slack');
    process.exit(0);
  }

  const production = httpsOrigin(setting('PRODUCTION_URL') ?? fail('PRODUCTION_URL is not set')) ?? fail('PRODUCTION_URL is not an https address');
  const allowed = (setting('ALLOWED_URLS') ?? '').split(/\s+/).filter((raw) => raw !== '').map((raw) => httpsOrigin(raw) ?? fail(`ALLOWED_URLS holds ${raw}, which is not an https address`));

  // What it tells Slack is production's, and only a dry run reads anything else.
  const requested = values.url ?? setting('DRY_RUN_URL');
  const origin = mode === 'watch' || requested === null ? production : allowedOrigin(requested, [production, ...allowed]);
  if (origin === null) fail(`a dry run only reads ${[production, ...allowed].join(', ')}, a Vercel preview (*.vercel.app) or the laptop`);

  const healthPath = setting('HEALTH_PATH') ?? '/api/health';
  if (!healthPath.startsWith('/')) fail('HEALTH_PATH starts with /');
  const detailsPath = setting('DETAILS_PATH');
  if (detailsPath !== null && !detailsPath.startsWith('/')) fail('DETAILS_PATH starts with /');
  const checksFile = values.checks ?? setting('CHECKS_FILE') ?? fail('CHECKS_FILE is not set: the words for each code are the project’s');
  const timeZone = setting('TIME_ZONE') ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    fail(`TIME_ZONE is not a time zone: ${timeZone}`);
  }

  let words: Readonly<Record<string, string>>;
  try {
    words = readChecks(JSON.parse(readFileSync(checksFile, 'utf8')) as unknown);
  } catch (error) {
    fail(`cannot read the checks file ${checksFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const context: Context = { project, origin, healthPath, words, detailsPath, timeZone };
  const read = await readEnvironment(`${origin}${healthPath}`);
  const now = new Date();

  if (mode === 'dry-run') {
    // Both messages, whatever the state: what a run would post when the checks start failing, and 6 hours on.
    const failing = read.kind === 'ok' ? [] : read.failing;
    console.log(`${origin}${healthPath}: ${read.kind === 'ok' ? 'ok' : failing.map((check) => check.code).join(', ')}`);
    const show = (message: Message | null) => console.log(message === null ? '(nothing to tell)' : `${plainText(message)}${values.payload ? `\n${JSON.stringify(payload(message), null, 2)}` : ''}`);
    console.log('\n--- when they start failing ---');
    show(alertMessage(decide(read, EMPTY_STATE, now), context, now));
    const toldBefore = { told: Object.fromEntries(failing.map((check) => [check.code, new Date(now.getTime() - REMIND_AFTER_MS).toISOString()])) };
    console.log('\n--- 6 hours later, still failing ---');
    show(alertMessage(decide(read, toldBefore, now), context, now));
    console.log('\n--- when they work again ---');
    show(alertMessage(decide({ kind: 'ok' }, toldBefore, now), context, now));
    process.exit(0);
  }

  const statePath = values.state ?? setting('STATE_FILE') ?? '.health-watch/state.json';
  const decision = decide(read, readState(readJson(statePath)), now);
  const message = alertMessage(decision, context, now);
  if (message !== null) await postToSlack(process.env.SLACK_WEBHOOK_URL, message);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(decision.next)}\n`);
  console.log(
    `health-watch ${read.kind === 'ok' ? 'ok' : read.failing.map((check) => check.code).join(', ')}` +
      ` — told ${decision.started.length} new, ${decision.reminded.length} reminded and ${decision.recovered.length} working again`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

/** The route, or production not answering: a timeout, a refused connection, a body that is not JSON. */
async function readEnvironment(url: string): Promise<HealthRead> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return readHealth(response.status, body);
  } catch (error) {
    console.error(`health-watch could not read ${url} (${error instanceof Error ? error.name : 'unknown error'})`);
    return readHealth(null, null);
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function httpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** One of the given origins, a Vercel preview or the laptop; nothing else is read. */
function allowedOrigin(raw: string, origins: string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (['localhost', '127.0.0.1'].includes(url.hostname)) return url.origin;
  if (url.protocol !== 'https:') return null;
  if (origins.includes(url.origin) || url.hostname.endsWith('.vercel.app')) return url.origin;
  return null;
}
