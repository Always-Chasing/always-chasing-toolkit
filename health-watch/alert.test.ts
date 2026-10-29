import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alertText, decide, EMPTY_STATE, readChecks, readHealth, readState, REMIND_AFTER_MS, testText, UNREACHABLE, type Context, type HealthRead } from './alert.ts';

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

  it('forgets what stopped failing, so failing again is news', () => {
    const recovered = decide({ kind: 'ok' }, { told: { connection_down: hoursAgo(1) } }, NOW);
    assert.deepEqual(recovered, { started: [], reminded: [], next: { told: {} } });
    assert.equal(decide(failing('connection_down'), recovered.next, NOW).started.length, 1);
  });
});

describe('what it says', () => {
  it('names the project, what started failing and what keeps failing, with since when, and where the detail is', () => {
    const text = alertText(
      {
        started: [{ code: 'connection_down', since: '2026-10-09T15:05:00.000Z' }],
        reminded: [
          { code: 'webhook_silent', since: null },
          { code: 'limit_near', since: null },
        ],
      },
      CONTEXT,
    );
    assert.equal(
      text,
      [
        '*Control Tower* · 🚨 *Production: a check started failing*',
        '• `connection_down` (since Oct 9, 9:05 AM CST): The WhatsApp number is disconnected from the panel.',
        '',
        '⏰ *Production: 2 checks are still failing*',
        '• `webhook_silent`: Meta took messages and its webhook has said nothing for 2 hours.',
        '• `limit_near`: The number nears its daily limit of new contacts.',
        '',
        'The detail, with its ids, is at <https://control-tower.example.com/diagnostics|/diagnostics>.',
      ].join('\n'),
    );
  });

  it('starts with the project when only reminders are news, and leaves out a detail page the project has not', () => {
    const text = alertText({ started: [], reminded: [{ code: 'limit_near', since: null }] }, { ...CONTEXT, detailsPath: null });
    assert.equal(text, ['*Control Tower* · ⏰ *Production: a check is still failing*', '• `limit_near`: The number nears its daily limit of new contacts.'].join('\n'));
  });

  it('says nothing when nothing is news, and names a code it does not know as itself', () => {
    assert.equal(alertText({ started: [], reminded: [] }, CONTEXT), null);
    assert.match(alertText({ started: [{ code: 'something_new', since: null }], reminded: [] }, CONTEXT) ?? '', /• `something_new`: A check this watch does not know\./);
  });

  it('has its own words for production not answering, which the project may replace', () => {
    const decision = { started: [{ code: UNREACHABLE, since: null }], reminded: [] };
    assert.match(alertText(decision, CONTEXT) ?? '', /• `unreachable`: Production does not answer: \/api\/health did not respond as it should\./);
    assert.match(alertText(decision, { ...CONTEXT, words: { unreachable: 'Nobody home.' } }) ?? '', /• `unreachable`: Nobody home\./);
  });

  it('escapes the words, so a sentence cannot become a link or a mention', () => {
    const text = alertText({ started: [{ code: 'queue_stuck', since: null }], reminded: [] }, { ...CONTEXT, words: { queue_stuck: 'Stuck <!channel> & co.' } });
    assert.match(text ?? '', /Stuck &lt;!channel&gt; &amp; co\./);
  });

  it('says a test is a test, naming the project', () => {
    assert.equal(testText('Control Tower'), '*Control Tower* · 🧪 *Health watch test*: this is how an alert reaches this channel. Nothing is failing.');
  });
});
