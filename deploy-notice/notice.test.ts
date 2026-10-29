import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
  commit: { sha: 'aec4dab3170fc046d3f29d57998e3ce9c57d9832', subject: 'Merge pull request #115 from Always-Chasing/test', url: 'https://github.com/o/r/commit/aec4dab' },
  pullRequests: [],
  links: {
    deployment: 'https://project-abc-team.vercel.app',
    logs: 'https://vercel.com/logs',
    migrations: 'https://github.com/o/r/runs/1',
    run: 'https://github.com/o/r/actions/runs/2',
  },
};

describe('every notice', () => {
  it('starts with the project, since every project posts through the same app', () => {
    for (const kind of ['build-failed', 'supabase-failed', 'migrations-stalled', 'not-served', 'live'] as const) {
      assert.ok(renderNotice({ ...base, kind }).startsWith('*Control Tower* · '));
    }
  });
});

describe('the notice for production', () => {
  it('says a failed build left the previous version live, with what Vercel said and a link to it', () => {
    const text = renderNotice({
      ...base,
      kind: 'build-failed',
      vercelSays: 'Deployment has failed — run this Vercel CLI command: npx vercel inspect dpl_abc --logs',
    });
    contains(text, '🚨 *Deploy failed in production*');
    contains(text, 'production is still on the previous one');
    contains(text, 'Vercel: Deployment has failed — run this Vercel CLI command: npx vercel inspect dpl_abc --logs');
    contains(text, '<https://vercel.com/logs|The deployment on Vercel>');
  });

  it('says failed migrations kept the new version off the domain', () => {
    const text = renderNotice({ ...base, kind: 'supabase-failed', supabaseStep: 'migrations' });
    contains(text, '🚨 *Migrations failed in production*');
    contains(text, "Supabase could not apply this commit's migrations");
    contains(text, 'Vercel did not publish the new version: production is still on the previous one.');
    contains(text, "<https://github.com/o/r/runs/1|Supabase's check>");
  });

  it('says failed buckets came after the migrations, which landed', () => {
    const text = renderNotice({ ...base, kind: 'supabase-failed', supabaseStep: 'buckets' });
    contains(text, '🚨 *Buckets failed in production*');
    contains(text, 'Supabase applied the migrations, but not the buckets in `supabase/config.toml`.');
    contains(text, 'Vercel did not publish the new version: production is still on the previous one.');
    lacks(text, 'Migrations failed');
  });

  it('blames no step it cannot tell, saying production is held all the same', () => {
    for (const supabaseStep of ['unknown', undefined] as const) {
      const text = renderNotice({ ...base, kind: 'supabase-failed', supabaseStep });
      contains(text, "🚨 *Supabase's check failed in production*");
      contains(text, 'it cannot tell whether the migrations were applied');
      contains(text, 'Vercel did not publish the new version: production is still on the previous one.');
      lacks(text, 'Migrations failed');
    }
  });

  it('says a stalled Supabase holds the release, and how to skip the wait', () => {
    const text = renderNotice({ ...base, kind: 'migrations-stalled', waitedMinutes: 30 });
    contains(text, '🚨 *Production held back*');
    contains(text, '30 minutes');
    contains(text, '«Force Promote»');
  });

  it('says the domain never took the new version although the migrations landed', () => {
    const text = renderNotice({ ...base, kind: 'not-served', waitedMinutes: 5 });
    contains(text, '🚨 *Production was not published*');
    contains(text, '5 minutes later the domain of production still serves another version');
  });

  it('lists what a release brought', () => {
    const text = renderNotice({
      ...base,
      kind: 'live',
      pullRequests: [
        { number: 104, title: 'feat(landing): a' },
        { number: 107, title: 'fix(landing): b' },
      ],
    });
    contains(text, '*Control Tower* · ✅ *Production published* — <https://github.com/o/r/commit/aec4dab|aec4dab>');
    contains(text, 'Brings 2 PRs:\n• #104 feat(landing): a\n• #107 fix(landing): b');
  });

  it('calls a release with nothing new a redeploy', () => {
    contains(renderNotice({ ...base, kind: 'live' }), 'it is a redeploy');
  });
});

describe('the notice for test', () => {
  const test = { ...base, environment: 'test' as const, commit: { ...base.commit, subject: 'fix(land-use): stop saying the team looks it up (#113)' } };

  it('says test is ready to try, naming the pull request in its heading', () => {
    const text = renderNotice({ ...test, kind: 'live', pullRequests: [{ number: 113, title: 'fix(land-use): stop saying the team looks it up' }] });
    contains(text, '✅ *`test` ready*');
    contains(text, '(#113)');
    contains(text, 'ready to try');
    lacks(text, 'Brings');
  });

  it('lists the pull requests when one deploy brought several', () => {
    const text = renderNotice({
      ...test,
      kind: 'live',
      pullRequests: [
        { number: 112, title: 'a' },
        { number: 113, title: 'b' },
      ],
    });
    contains(text, 'Brings 2 PRs:');
  });

  it('warns that failed migrations left the new code over the old schema', () => {
    const text = renderNotice({ ...test, kind: 'supabase-failed', supabaseStep: 'migrations' });
    contains(text, '🚨 *Migrations failed in `test`*');
    contains(text, 'the new code is already live there');
  });

  it('warns that failed buckets left the new code without them', () => {
    const text = renderNotice({ ...test, kind: 'supabase-failed', supabaseStep: 'buckets' });
    contains(text, '🚨 *Buckets failed in `test`*');
    contains(text, 'Supabase applied the migrations to `test`');
    contains(text, 'it may fail wherever it uses them');
  });

  it('says nothing of the migrations when the step is unknown, nor that production is held', () => {
    const text = renderNotice({ ...test, kind: 'supabase-failed', supabaseStep: 'unknown' });
    contains(text, "🚨 *Supabase's check failed in `test`*");
    contains(text, 'it cannot tell whether the migrations of `test` were applied');
    lacks(text, 'production');
  });
});

describe('text taken from outside', () => {
  it('is escaped, so a subject cannot become a link or a mention', () => {
    const text = renderNotice({ ...base, kind: 'live', commit: { ...base.commit, subject: 'fix: <b> & <!channel>' } });
    contains(text, 'fix: &lt;b&gt; &amp; &lt;!channel&gt;');
    lacks(text, '<!channel>');
  });

  it('escapes the project name too', () => {
    assert.ok(renderNotice({ ...base, project: 'A <b> & co', kind: 'live' }).startsWith('*A &lt;b&gt; &amp; co* · '));
  });
});
