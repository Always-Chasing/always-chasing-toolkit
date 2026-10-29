import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stepsLine, type Message } from '../lib/slack.ts';
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
  type Notice,
} from './notice.ts';

const contains = (text: string, part: string) => assert.ok(text.includes(part), `expected the notice to contain ${JSON.stringify(part)}:\n${text}`);
const lacks = (text: string, part: string) => assert.ok(!text.includes(part), `expected the notice not to contain ${JSON.stringify(part)}:\n${text}`);

describe('which deploys are told', () => {
  const names = { production: 'Production', test: 'staging' };

  it('names production and test by the environments Vercel reports them under', () => {
    assert.equal(environmentOf('Production', names), 'production');
    assert.equal(environmentOf('staging', names), 'test');
    assert.equal(environmentOf('qa', { production: 'Production', test: 'qa' }), 'test');
  });

  it('leaves previews out, and test when the project has none', () => {
    assert.equal(environmentOf('Preview', names), null);
    assert.equal(environmentOf('production', names), null);
    assert.equal(environmentOf('staging', { production: 'Production', test: null }), null);
  });
});

describe('the build', () => {
  it('is ready on success and failed on failure or error', () => {
    assert.equal(buildOutcome('success'), 'ready');
    assert.equal(buildOutcome('failure'), 'failed');
    assert.equal(buildOutcome('error'), 'failed');
  });

  it('says nothing for a state that is not final', () => {
    assert.equal(buildOutcome('pending'), null);
    assert.equal(buildOutcome('inactive'), null);
  });
});

describe('which deploys Vercel built', () => {
  it('counts a published one', () => {
    assert.equal(builtByVercel({ state: 'success', description: 'Deployment has completed' }), true);
  });

  it('counts one the migrations check held back, although Vercel reports it as a failure', () => {
    assert.equal(builtByVercel({ state: 'failure', description: 'Checks for Deployment have failed' }), true);
  });

  it('does not count a build that failed, nor one that has not ended', () => {
    assert.equal(
      builtByVercel({
        state: 'failure',
        description: 'Deployment has failed — run this Vercel CLI command: npx vercel inspect dpl_3u1KHAvNZyerJD33FT5hYYz9ntn6 --logs',
      }),
      false,
    );
    assert.equal(builtByVercel({ state: 'failure', description: null }), false);
    assert.equal(builtByVercel({ state: 'error' }), false);
    assert.equal(builtByVercel({ state: 'pending', description: 'Vercel is deploying your app' }), false);
  });
});

describe('the migrations', () => {
  it('are pending while Supabase has not created or finished its check', () => {
    assert.equal(migrationsOutcome(undefined), 'pending');
    assert.equal(migrationsOutcome({ status: 'in_progress', conclusion: null }), 'pending');
    assert.equal(migrationsOutcome({ status: 'queued', conclusion: null }), 'pending');
  });

  it('are applied when the check succeeded, or had nothing to do', () => {
    assert.equal(migrationsOutcome({ status: 'completed', conclusion: 'success' }), 'applied');
    assert.equal(migrationsOutcome({ status: 'completed', conclusion: 'skipped' }), 'applied');
    assert.equal(migrationsOutcome({ status: 'completed', conclusion: 'neutral' }), 'applied');
  });

  it('failed on any other conclusion', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale']) {
      assert.equal(migrationsOutcome({ status: 'completed', conclusion }), 'failed');
    }
  });
});

describe('which step of Supabase failed', () => {
  it('is the migrations on a SQL error, or on the history of migrations', () => {
    assert.equal(failedSupabaseStep('```\nERROR: column "price" does not exist (SQLSTATE 42703)\nAt statement 0: update terrain set price = 0\n```'), 'migrations');
    // What Supabase said on a branch whose database had migrations the branch did not.
    assert.equal(failedSupabaseStep('```\nRemote migration versions not found in local migrations directory.\n```'), 'migrations');
  });

  it('is the buckets when Storage refused one', () => {
    const summary =
      '```\nError status 400: {"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size","code":"EntityTooLarge"}\n```';
    assert.equal(failedSupabaseStep(summary), 'buckets');
  });

  it('trusts the error of a step over a word of the other', () => {
    assert.equal(failedSupabaseStep('ERROR: relation "storage.buckets" does not exist (SQLSTATE 42P01)'), 'migrations');
    assert.equal(failedSupabaseStep('Applied 12 migrations.\nError status 400: {"code":"EntityTooLarge"}'), 'buckets');
  });

  it('is unknown otherwise, so nothing is said of the migrations', () => {
    for (const summary of ['Preview branch not found', 'Failed to update config for branch: feature/public-landing', '', null, undefined]) {
      assert.equal(failedSupabaseStep(summary), 'unknown');
    }
  });
});

describe('what Vercel says about a commit', () => {
  it('is published once the deployment took its domains', () => {
    assert.equal(publicationOutcome('success'), 'published');
  });

  it('failed on failure or error', () => {
    assert.equal(publicationOutcome('failure'), 'failed');
    assert.equal(publicationOutcome('error'), 'failed');
  });

  it('is pending while it builds or waits for the migrations check, and before it says anything', () => {
    assert.equal(publicationOutcome('pending'), 'pending');
    assert.equal(publicationOutcome(undefined), 'pending');
  });
});

describe('the release watch', () => {
  it('reports a Supabase check that failed or stalled, whatever Vercel says', () => {
    for (const publication of ['published', 'failed', 'pending'] as const) {
      assert.equal(releaseNotice('failed', publication, false), 'supabase-failed');
      assert.equal(releaseNotice('stalled', publication, false), 'migrations-stalled');
    }
  });

  it('reports a database that is ready while Vercel still did not publish', () => {
    assert.equal(releaseNotice('applied', 'pending', false), 'not-served');
  });

  it('stays quiet when the deploy notice speaks, or a newer release took over', () => {
    assert.equal(releaseNotice('applied', 'published', false), null);
    assert.equal(releaseNotice('applied', 'failed', false), null);
    assert.equal(releaseNotice('applied', 'pending', true), null);
  });

  it('still reports the failed Supabase check of a release a newer one took over', () => {
    assert.equal(releaseNotice('failed', 'pending', true), 'supabase-failed');
  });
});

describe('a failed production deployment', () => {
  it('is left to the release watch when Supabase failed its check on the same commit', () => {
    assert.equal(leftToReleaseWatch('production', 'failed'), true);
  });

  it('is the deploy notice to tell otherwise, and always in test', () => {
    assert.equal(leftToReleaseWatch('production', 'applied'), false);
    assert.equal(leftToReleaseWatch('production', 'pending'), false);
    assert.equal(leftToReleaseWatch('test', 'failed'), false);
  });
});

describe('which deployment a page was served by', () => {
  it('reads the deployment id Next stamps on the root element', () => {
    const html = '<!DOCTYPE html><html lang="es-MX" data-dpl-id="dpl_2G4nfHWZ97fHqQvrTpY5LHGMTPqW" class="x"><head>';
    assert.equal(deploymentMarker(html), 'dpl_2G4nfHWZ97fHqQvrTpY5LHGMTPqW');
  });

  it('does not take the id from anywhere but the root element', () => {
    assert.equal(deploymentMarker('<html lang="es-MX"><body><img src="/_next/image?url=a.jpg&amp;dpl=dpl_abc123"></body></html>'), null);
  });

  it('is null on a page without one', () => {
    assert.equal(deploymentMarker('<html><body>nothing here</body></html>'), null);
  });
});

describe('the pull requests a range brought', () => {
  it('reads the number and title of each squashed commit, in order', () => {
    assert.deepEqual(
      pullRequestsIn([
        'fix(landing): say we turn land into homes, not buildings (#99)',
        'feat(address): limit the form’s address lookups per IP (#97)',
      ]),
      [
        { number: 97, title: 'feat(address): limit the form’s address lookups per IP' },
        { number: 99, title: 'fix(landing): say we turn land into homes, not buildings' },
      ],
    );
  });

  it('ignores a subject without a number, and counts a repeated one once', () => {
    assert.deepEqual(pullRequestsIn(['ci: nudge Vercel', 'fix: a (#5)', 'fix: a again (#5)']), [{ number: 5, title: 'fix: a again' }]);
  });
});

const base: Omit<Notice, 'kind'> = {
  project: 'Control Tower',
  environment: 'production',
  testName: 'test',
  repoUrl: 'https://github.com/o/r',
  commit: { sha: 'aec4dab3170fc046d3f29d57998e3ce9c57d9832', subject: 'Merge pull request #115 from Always-Chasing/test', url: 'https://github.com/o/r/commit/aec4dab' },
  change: { number: 115, title: 'chore: release the board to production' },
  release: true,
  pullRequests: [],
  links: {
    site: 'https://control-tower.example.com',
    deployment: 'https://project-abc-team.vercel.app',
    logs: 'https://vercel.com/logs',
    migrations: 'https://github.com/o/r/runs/1',
    run: 'https://github.com/o/r/actions/runs/2',
  },
};

const field = (message: Message, label: string) => message.fields?.find((candidate) => candidate.label === label)?.value ?? '';

describe('every notice', () => {
  it('titles what happened with the project, and names the release or change and the commit', () => {
    for (const kind of ['build-failed', 'supabase-failed', 'migrations-stalled', 'not-served', 'live'] as const) {
      const message = renderNotice({ ...base, kind });
      assert.ok(message.title.startsWith('Control Tower · '), message.title);
      assert.equal(field(message, 'Release'), '<https://github.com/o/r/pull/115|#115 Release the board to production>');
      assert.equal(field(message, 'Commit'), '<https://github.com/o/r/commit/aec4dab|aec4dab>');
    }
  });

  it('is red when something went wrong, and says what happened and what to do', () => {
    for (const kind of ['build-failed', 'supabase-failed', 'migrations-stalled', 'not-served'] as const) {
      const message = renderNotice({ ...base, kind });
      assert.equal(message.tone, 'bad');
      assert.notEqual(field(message, 'What happened'), '');
      assert.notEqual(field(message, 'What to do'), '');
    }
  });

  it('names a commit nobody opened a pull request for by its subject', () => {
    const message = renderNotice({ ...base, kind: 'live', change: null, release: false, commit: { ...base.commit, subject: 'fix: a <b> & <!channel>' } });
    assert.equal(field(message, 'Change'), 'fix: a &lt;b&gt; &amp; &lt;!channel&gt;');
  });
});

describe('the notice for production', () => {
  it('says production updated, in green, with every step done and what the release brought', () => {
    const message = renderNotice({
      ...base,
      kind: 'live',
      pullRequests: [
        { number: 104, title: 'feat(landing): show the map' },
        { number: 107, title: 'fix(landing): <b> the pin' },
      ],
    });
    assert.deepEqual(message, {
      title: 'Control Tower · production updated',
      tone: 'good',
      steps: [
        { state: 'done', label: 'Code built' },
        { state: 'done', label: 'Database updated' },
        { state: 'done', label: 'Site live' },
      ],
      fields: [
        { label: 'Release', value: '<https://github.com/o/r/pull/115|#115 Release the board to production>' },
        { label: 'Commit', value: '<https://github.com/o/r/commit/aec4dab|aec4dab>' },
      ],
      list: {
        label: "What's new (2)",
        items: ['• <https://github.com/o/r/pull/104|#104> Show the map', '• <https://github.com/o/r/pull/107|#107> &lt;b&gt; the pin'],
      },
      footer: ['<https://control-tower.example.com|Open production>'],
    });
  });

  it('calls a deploy with nothing new a redeploy', () => {
    assert.match(renderNotice({ ...base, kind: 'live', change: null, release: false }).note ?? '', /it is a redeploy/);
  });

  it('says a failed build left the previous version live, with what Vercel said and its log', () => {
    const message = renderNotice({ ...base, kind: 'build-failed', vercelSays: 'Deployment has failed — run npx vercel inspect dpl_abc --logs' });
    assert.equal(message.title, 'Control Tower · the production build failed');
    assert.equal(stepsLine(message.steps ?? []), '❌ Code built → ⏸ Site held back');
    contains(field(message, 'What happened'), 'production is still on the previous one. Vercel: Deployment has failed — run npx vercel inspect dpl_abc --logs');
    assert.deepEqual(message.footer, ['<https://vercel.com/logs|Build log in Vercel>']);
  });

  it('says failed migrations held the new version back', () => {
    const message = renderNotice({ ...base, kind: 'supabase-failed', supabaseStep: 'migrations' });
    assert.equal(message.title, 'Control Tower · the production database update failed');
    assert.equal(stepsLine(message.steps ?? []), '✅ Code built → ❌ Database updated → ⏸ Site held back');
    contains(field(message, 'What happened'), 'Production is still on the previous version.');
    assert.deepEqual(message.footer, ["<https://github.com/o/r/runs/1|Supabase's check>"]);
  });

  it('says failed buckets came after the migrations, which landed', () => {
    const message = renderNotice({ ...base, kind: 'supabase-failed', supabaseStep: 'buckets' });
    assert.equal(stepsLine(message.steps ?? []), '✅ Code built → ✅ Database updated → ❌ Storage buckets → ⏸ Site held back');
    contains(field(message, 'What happened'), 'Supabase applied the migrations, but not the buckets in `supabase/config.toml`');
  });

  it('blames no step it cannot tell, saying production is held all the same', () => {
    for (const supabaseStep of ['unknown', undefined] as const) {
      const message = renderNotice({ ...base, kind: 'supabase-failed', supabaseStep });
      assert.equal(message.title, "Control Tower · Supabase's check failed for production");
      contains(field(message, 'What happened'), 'it cannot tell whether the migrations were applied');
      lacks(stepsLine(message.steps ?? []), 'Database');
    }
  });

  it('says a stalled Supabase holds the release, and how to skip the wait', () => {
    const message = renderNotice({ ...base, kind: 'migrations-stalled', waitedMinutes: 30 });
    assert.equal(message.title, 'Control Tower · production deploy is stuck');
    assert.equal(stepsLine(message.steps ?? []), '✅ Code built → ⏳ Database updating → ⏸ Site held back');
    contains(field(message, 'What happened'), '30 minutes');
    contains(field(message, 'What to do'), '«Force Promote»');
  });

  it('says the domain never took the new version although the migrations landed', () => {
    const message = renderNotice({ ...base, kind: 'not-served', waitedMinutes: 5 });
    assert.equal(message.title, 'Control Tower · production did not go live');
    assert.equal(stepsLine(message.steps ?? []), '✅ Code built → ✅ Database updated → ❌ Site live');
    contains(field(message, 'What happened'), '5 minutes later the domain of production still serves another version');
  });
});

describe('the notice for test', () => {
  const test: Omit<Notice, 'kind'> = {
    ...base,
    environment: 'test',
    change: { number: 113, title: 'fix(land-use): stop saying the team looks it up' },
    release: false,
    links: { ...base.links, site: 'https://test.control-tower.example.com' },
  };

  it('says test is ready to try, in blue, naming its change and nothing more', () => {
    const message = renderNotice({ ...test, kind: 'live', pullRequests: [{ number: 113, title: 'fix(land-use): stop saying the team looks it up' }] });
    assert.equal(message.title, 'Control Tower · test is ready to try');
    assert.equal(message.tone, 'ready');
    assert.equal(field(message, 'Change'), '<https://github.com/o/r/pull/113|#113 Stop saying the team looks it up>');
    assert.equal(message.list, undefined);
    assert.deepEqual(message.footer, ['<https://test.control-tower.example.com|Open test>']);
  });

  it('calls the gate by its branch', () => {
    assert.equal(renderNotice({ ...test, testName: 'staging', kind: 'live' }).title, 'Control Tower · staging is ready to try');
  });

  it('lists what entered with it when one deploy brought more than its change', () => {
    const message = renderNotice({
      ...test,
      kind: 'live',
      pullRequests: [
        { number: 112, title: 'a' },
        { number: 113, title: 'b' },
      ],
    });
    assert.equal(message.list?.label, "What's new (2)");
  });

  it('warns that failed migrations left the new code over the old schema', () => {
    const message = renderNotice({ ...test, kind: 'supabase-failed', supabaseStep: 'migrations' });
    assert.equal(message.title, 'Control Tower · the test database update failed');
    assert.equal(stepsLine(message.steps ?? []), '✅ Code built → ❌ Database updated → ✅ Site live');
    contains(field(message, 'What happened'), 'the new code is already live in `test`');
  });

  it('warns that failed buckets left the new code without them', () => {
    const message = renderNotice({ ...test, kind: 'supabase-failed', supabaseStep: 'buckets' });
    contains(field(message, 'What happened'), 'it may fail wherever it uses them');
  });

  it('says nothing of the migrations when the step is unknown, nor that production is held', () => {
    const message = renderNotice({ ...test, kind: 'supabase-failed', supabaseStep: 'unknown' });
    contains(field(message, 'What happened'), 'it cannot tell whether the migrations were applied');
    lacks(JSON.stringify(message), 'roduction');
  });
});

describe('the same report twice', () => {
  const statuses = [
    { id: 20950890311, state: 'success' },
    { id: 20950822520, state: 'success' },
    { id: 20950800000, state: 'in_progress' },
  ];

  it('is told once: Control Tower\'s 7425348273 got two successes', () => {
    assert.equal(repeatsEarlierStatus(statuses, 20950822520), false);
    assert.equal(repeatsEarlierStatus(statuses, 20950890311), true);
  });

  it('is news when the state changed, such as a held release published later', () => {
    assert.equal(repeatsEarlierStatus([{ id: 3, state: 'success' }, { id: 2, state: 'failure' }], 3), false);
  });

  it('is not judged for a status that is not final, or that is not there', () => {
    assert.equal(repeatsEarlierStatus(statuses, 20950800000), false);
    assert.equal(repeatsEarlierStatus(statuses, 1), false);
  });
});
