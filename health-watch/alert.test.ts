import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { payload } from '../lib/slack.ts';
import { alertMessage, checkName, decide, EMPTY_STATE, readChecks, readHealth, readState, REMIND_AFTER_MS, testMessage, UNREACHABLE, type Context, type Decision, type HealthRead } from './alert.ts';

const NOW = new Date('2026-10-09T18:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60_000).toISOString();
const failing = (...codes: string[]): HealthRead => ({ kind: 'failing', failing: codes.map((code) => ({ code, since: null })) });

const CONTEXT: Context = {
  project: 'Control Tower',
  origin: 'https://control-tower.example.com',
  healthPath: '/api/health',
  words: {
    connection_down: 'The WhatsApp number is disconnected from the panel.',
    webhook_silent: 'Meta took messages and its webhook has said nothing for 2 hours.',
    limit_near: 'The number nears its daily limit of new contacts.',
  },
  detailsPath: '/diagnostics',
  timeZone: 'America/Mexico_City',
};

describe('what /api/health said', () => {
  it('reads ok, and the failing codes with since when', () => {
    assert.deepEqual(readHealth(200, { status: 'ok' }), { kind: 'ok' });
    assert.deepEqual(
      readHealth(503, { status: 'failing', failing: [{ code: 'connection_down', since: '2026-10-09T15:00:00.000Z' }, { code: 'limit_near', since: null }] }),
      {
        kind: 'failing',
        failing: [
          { code: 'connection_down', since: '2026-10-09T15:00:00.000Z' },
          { code: 'limit_near', since: null },
        ],
      },
    );
  });

  it('takes anything else as production not answering', () => {
    const unreachable = { kind: 'failing', failing: [{ code: UNREACHABLE, since: null }] };
    assert.deepEqual(readHealth(null, null), unreachable);
    assert.deepEqual(readHealth(500, { status: 'ok' }), unreachable);
    assert.deepEqual(readHealth(200, '<html>'), unreachable);
    assert.deepEqual(readHealth(503, { status: 'failing', failing: [] }), unreachable);
    assert.deepEqual(readHealth(503, { status: 'failing', failing: [{ code: '<script>' }] }), unreachable);
  });
});

describe("the project's words", () => {
  it('takes an object of code to one sentence, trimmed', () => {
    assert.deepEqual(readChecks({ queue_stuck: ' A queue is stuck. ' }), { queue_stuck: 'A queue is stuck.' });
  });

  it('refuses anything else, so a broken file fails the run', () => {
    for (const broken of [null, [], 'x', { 'Queue-Stuck': 'A queue is stuck.' }, { queue_stuck: '' }, { queue_stuck: 3 }]) {
      assert.throws(() => readChecks(broken));
    }
  });
});

describe('what the watch remembers', () => {
  it('keeps only codes with an instant, and starts empty from anything else', () => {
    assert.deepEqual(readState({ told: { connection_down: hoursAgo(1), limit_near: 'yesterday', webhook_silent: 4 } }), { told: { connection_down: hoursAgo(1) } });
    for (const garbage of [null, 'x', { told: null }, []]) assert.deepEqual(readState(garbage), EMPTY_STATE);
  });
});

describe('when it tells Slack', () => {
  it('tells what starts failing, once', () => {
    const first = decide(failing('connection_down'), EMPTY_STATE, NOW);
    assert.deepEqual(
      first.started.map((check) => check.code),
      ['connection_down'],
    );
    assert.deepEqual(first.next, { told: { connection_down: NOW.toISOString() } });

    const later = decide(failing('connection_down'), { told: { connection_down: hoursAgo(5.9) } }, NOW);
    assert.deepEqual([later.started, later.reminded], [[], []]);
    assert.deepEqual(later.next, { told: { connection_down: hoursAgo(5.9) } });
  });

  it('reminds every 6 hours while it keeps failing', () => {
    const reminder = decide(failing('connection_down'), { told: { connection_down: new Date(NOW.getTime() - REMIND_AFTER_MS).toISOString() } }, NOW);
    assert.deepEqual(
      reminder.reminded.map((check) => check.code),
      ['connection_down'],
    );
    assert.deepEqual(reminder.next, { told: { connection_down: NOW.toISOString() } });
  });

  it('tells what stopped failing, and forgets it, so failing again is news', () => {
    const recovered = decide({ kind: 'ok' }, { told: { connection_down: hoursAgo(1) } }, NOW);
    assert.deepEqual(recovered, { started: [], reminded: [], recovered: ['connection_down'], next: { told: {} } });
    assert.equal(decide(failing('connection_down'), recovered.next, NOW).started.length, 1);
  });
});

const told = (codes: Record<string, string>): Decision['next'] => ({ told: codes });
const decision = (part: Partial<Decision>): Decision => ({ started: [], reminded: [], recovered: [], next: told({}), ...part });

describe('what it says', () => {
  it('titles what fails with the project, in amber, one row per check with since when and what it means', () => {
    const message = alertMessage(
      decision({
        started: [{ code: 'connection_down', since: '2026-10-09T17:37:00.000Z' }],
        reminded: [{ code: 'webhook_silent', since: '2026-10-08T15:05:00.000Z' }],
      }),
      CONTEXT,
      NOW,
    );
    assert.deepEqual(message, {
      title: 'Control Tower · production has 2 problems',
      tone: 'warning',
      fields: [
        { label: 'Connection down', value: 'Since 11:37 AM CST · The WhatsApp number is disconnected from the panel.' },
        { label: 'Webhook silent', value: 'Since Oct 8, 9:05 AM CST · Meta took messages and its webhook has said nothing for 2 hours.' },
      ],
      footer: ['Reminder every 6 h while it fails', '<https://control-tower.example.com/diagnostics|Open diagnostics>'],
    });
  });

  it('says production still has them when only reminders are news, and leaves out a detail page the project has not', () => {
    const message = alertMessage(decision({ reminded: [{ code: 'limit_near', since: null }] }), { ...CONTEXT, detailsPath: null }, NOW);
    assert.equal(message?.title, 'Control Tower · production still has a problem');
    assert.deepEqual(message?.fields, [{ label: 'Limit near', value: 'The number nears its daily limit of new contacts.' }]);
    assert.deepEqual(message?.footer, ['Reminder every 6 h while it fails']);
  });

  it('tells in green when production is back to normal', () => {
    const message = alertMessage(decision({ recovered: ['connection_down', UNREACHABLE] }), CONTEXT, NOW);
    assert.equal(message?.title, 'Control Tower · production is back to normal');
    assert.equal(message?.tone, 'good');
    assert.deepEqual(message?.fields, [
      { label: 'Connection down', value: '✅ Fixed' },
      { label: 'Production does not answer', value: '✅ Fixed' },
    ]);
  });

  it('names what still fails when only part of it got fixed', () => {
    const message = alertMessage(decision({ recovered: ['connection_down'], next: told({ limit_near: hoursAgo(1) }) }), CONTEXT, NOW);
    assert.equal(message?.title, 'Control Tower · a problem is fixed in production');
    assert.deepEqual(message?.fields?.at(-1), { label: 'Still failing', value: 'Limit near' });
  });

  it('lists what got fixed beside what fails, when both happen at once', () => {
    const message = alertMessage(decision({ started: [{ code: 'limit_near', since: null }], recovered: ['connection_down'] }), CONTEXT, NOW);
    assert.equal(message?.tone, 'warning');
    assert.deepEqual(message?.fields?.map((field) => field.value), ['The number nears its daily limit of new contacts.', '✅ Fixed']);
  });

  it('says nothing when nothing is news, and names a code it does not know as itself', () => {
    assert.equal(alertMessage(decision({}), CONTEXT, NOW), null);
    assert.deepEqual(alertMessage(decision({ started: [{ code: 'something_new', since: null }] }), CONTEXT, NOW)?.fields, [
      { label: 'Something new', value: 'A check this watch does not know.' },
    ]);
  });

  it('has its own words for production not answering, which the project may replace', () => {
    const down = decision({ started: [{ code: UNREACHABLE, since: null }] });
    assert.deepEqual(alertMessage(down, CONTEXT, NOW)?.fields, [{ label: 'Production does not answer', value: '/api/health did not respond as it should.' }]);
    assert.equal(alertMessage(down, { ...CONTEXT, words: { unreachable: 'Nobody home.' } }, NOW)?.fields?.[0]?.value, 'Nobody home.');
  });

  it('escapes the words, so a sentence cannot become a link or a mention', () => {
    const message = alertMessage(decision({ started: [{ code: 'queue_stuck', since: null }] }), { ...CONTEXT, words: { queue_stuck: 'Stuck <!channel> & co.' } }, NOW);
    assert.equal(message?.fields?.[0]?.value, 'Stuck &lt;!channel&gt; &amp; co.');
  });

  it('names checks in words', () => {
    assert.equal(checkName('queue_stuck'), 'Queue stuck');
    assert.equal(checkName(UNREACHABLE), 'Production does not answer');
  });

  it('says a test is a test, naming the project', () => {
    const message = testMessage('Control Tower');
    assert.equal(message.title, 'Control Tower · health watch test');
    assert.match(JSON.stringify(payload(message)), /Nothing is failing\./);
  });
});
