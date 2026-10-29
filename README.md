# Always Chasing Toolkit

GitHub actions that every Always Chasing project reuses: two Slack alerts for projects on Vercel
and Supabase, and the check that keeps every pull request within the Git conventions.

| Action | What it does |
|---|---|
| [`deploy-notice`](deploy-notice/action.yml) | Tells whether a deploy of `test` or production went live: Vercel's build, Supabase's migrations, and whether the domain already serves the new version. When it did not go live, it says why |
| [`health-watch`](health-watch/action.yml) | Tells what started failing in production, read from the project's `/api/health` every half hour, and reminds every 6 hours while it keeps failing. It also speaks when production does not answer at all |
| [`pr-rules`](pr-rules/action.yml) | Fails a pull request whose title, branch, base or link to Linear breaks the conventions, and says how to fix it. A release must complete every issue it releases |

And one command, [`release-pr`](release-pr/draft.ts), that drafts the release pull request of a
repo with a gate: what entered `test` since the last release, and a `Completes` line for each
issue, compared with the issues in In Test.

Both alerts post to `#alerts`, the private channel of the «Always Chasing» Slack, through one
app, Mr.Chase. All the projects post through the same app, so **every message starts with the
project's name**. The messages are in English.

The repo is public, and holds nothing but code: the webhook lives in each organization's
secrets, never here. Being public is what lets every project use it as it uses any other action:
the security audits of its CI can read it, and Dependabot can tell when a new version is out.

## Projects that use it

| Project | Repo | Uses |
|---|---|---|
| Control Tower | `Always-Chasing/estrategia-urbana-control-tower` | `deploy-notice`, `health-watch`, `pr-rules` |
| ECO | `Always-Chasing/cabreras-eco` | `deploy-notice`, `health-watch` (hourly), `pr-rules` |

## Add the alerts to a project

### 1. Give the repo the secret

The webhook lives in one organization secret, `SLACK_ALERTS_WEBHOOK_URL`, visible to the repos
that are selected. Add the repo in *Organization settings → Secrets and variables → Actions →
`SLACK_ALERTS_WEBHOOK_URL` → Repository access*, or:

```bash
gh api -X PUT "orgs/Always-Chasing/actions/secrets/SLACK_ALERTS_WEBHOOK_URL/repositories/$(gh api repos/Always-Chasing/<repo> --jq .id)"
```

**A repo secret with the same name wins over the organization's**: if the repo had one, delete
it, or the alerts keep going wherever it points.

### 2. Add the deploy notice

What the project needs:

- **Vercel's GitHub integration**, which reports each deployment to GitHub and leaves a «Vercel»
  status on each commit.
- **Supabase Branching**, whose «Supabase Preview» check applies the migrations of each commit.
- **Skew protection on in Vercel.** Next stamps every page and navigation with the id of the
  deployment that served it, and that id is how the notice knows the domain serves the new
  version.
- **A page that answers on every host without a session** (`probe-path`), ideally one that does
  not touch the database.
- Optional: a Vercel Deployment Check that holds production until «Supabase Preview» passes. Set
  `migrations-wait-minutes` to its timeout.

`.github/workflows/deploy-notices.yml`, with the project's values:

```yaml
name: Deploy notices

on:
  deployment_status:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      deployment:
        description: 'The id of a deployment of test or production to tell about'
        type: string
        required: true
      dry-run:
        description: 'Print the notice without posting it'
        type: boolean
        default: true

permissions: {}

jobs:
  notify:
    name: Deploy notice
    # Vercel reports previews too; GitHub cannot filter this trigger by environment.
    if: >-
      github.event_name == 'workflow_dispatch'
      || (github.event_name == 'deployment_status'
      && contains(fromJSON('["Production", "staging"]'), github.event.deployment_status.environment)
      && contains(fromJSON('["success", "failure", "error"]'), github.event.deployment_status.state))
    runs-on: ubuntu-24.04
    # The wait for Supabase, 5 minutes for the domain, and room to post.
    timeout-minutes: 45
    permissions:
      contents: read
      checks: read
      deployments: read
    steps:
      - uses: Always-Chasing/always-chasing-toolkit/deploy-notice@<full SHA of the version> # v1.2.0
        with:
          project: Example
          webhook-url: ${{ secrets.SLACK_ALERTS_WEBHOOK_URL }}
          production-url: https://example.com
          test-url: https://test.example.com
          deployment-id: ${{ inputs.deployment }}
          dry-run: ${{ inputs.dry-run }}

  release:
    name: Release watch
    if: github.event_name == 'push'
    runs-on: ubuntu-24.04
    # The wait for Supabase, 10 minutes for Vercel to publish, and room to post.
    timeout-minutes: 50
    permissions:
      contents: read
      checks: read
      statuses: read
    steps:
      - uses: Always-Chasing/always-chasing-toolkit/deploy-notice@<full SHA of the version> # v1.2.0
        with:
          project: Example
          webhook-url: ${{ secrets.SLACK_ALERTS_WEBHOOK_URL }}
          production-url: https://example.com
          test-url: https://test.example.com
```

Two jobs, because GitHub hears of a deploy at different moments. Vercel reports `test` when the
build ends. A production that waits for its migrations is reported only when the wait ends,
published or held back. The deploy notice starts with that report. The release watch starts
with the merge to `main`, so a release whose wait never ends is still heard of. It speaks only
when the deploy notice cannot.

Without `test-url`, `test` deploys are left alone. The other inputs, with their defaults, are in
[`deploy-notice/action.yml`](deploy-notice/action.yml). The notices themselves are in
[`deploy-notice/notice.ts`](deploy-notice/notice.ts):

| Notice | What happened |
|---|---|
| ✅ `test` ready | The code and the database of `test` are both there |
| ✅ Production published | The domain serves the new version; lists the pull requests since the previous release |
| 🚨 Deploy failed | Vercel could not build it; the environment is still on the previous version |
| 🚨 Migrations failed | Supabase could not apply them. Production published nothing; in `test`, the new code is live over the old schema |
| 🚨 Buckets failed | Supabase applied the migrations, but not the buckets of `supabase/config.toml` |
| 🚨 Supabase's check failed | A step the notice does not recognize failed, so it says nothing of the migrations |
| 🚨 Production held back | Supabase has not finished within the wait, and Vercel does not publish until it does |
| 🚨 Not published | The migrations finished, and minutes later the domain still serves another version |

### 3. Add the health watch

The project's route answers one of two ways, and nothing else counts as an answer:

```text
200 {"status":"ok"}
503 {"status":"failing","failing":[{"code":"queue_stuck","since":"2026-10-27T15:05:00.000Z"}]}
```

A code is lowercase letters and underscores, and `since` is optional. The route carries no
data, only codes, because the message carries what the route says. Anything else is
production not answering, and that alerts too, as `unreachable`.

The words for each code are the project's, in a JSON file of its own, one sentence per code:

```json
{
  "queue_stuck": "A message has been waiting for more than 10 minutes and nobody takes it."
}
```

A code the file does not have still goes out, as itself. `unreachable` has words of its own,
which the file may replace.

`.github/workflows/health-watch.yml`, with the project's values:

```yaml
name: Health watch

on:
  schedule:
    # Off the hour, when GitHub's scheduled runs pile up and start late.
    - cron: '7,37 * * * *'
  workflow_dispatch:
    inputs:
      mode:
        description: 'dry-run prints without posting; test posts a test alert; watch runs as the schedule'
        type: choice
        options: [dry-run, test, watch]
        default: dry-run
      url:
        description: 'What a dry run reads: production, or a preview'
        type: string
        default: https://example.com

permissions: {}

concurrency:
  group: health-watch
  cancel-in-progress: false

jobs:
  watch:
    name: Health watch
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      # The checks file and nothing else.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          sparse-checkout: health-checks.json
          sparse-checkout-cone-mode: false
      - uses: Always-Chasing/always-chasing-toolkit/health-watch@<full SHA of the version> # v1.2.0
        with:
          project: Example
          webhook-url: ${{ secrets.SLACK_ALERTS_WEBHOOK_URL }}
          production-url: https://example.com
          checks-file: health-checks.json
          mode: ${{ inputs.mode || 'watch' }}
          dry-run-url: ${{ inputs.url }}
```

- **It tells what starts failing, and reminds every 6 hours while it keeps failing.** What
  stopped failing is forgotten: if it comes back, it is news again. It does not tell when
  something gets fixed.
- **Its memory is the Actions cache**: what it last told of each code, in a file each watch
  restores and saves under its own key. If the cache is lost, it only repeats an alert.
- **A watch reads production and nothing else.** A dry run may also read `allowed-urls`, a
  Vercel preview or localhost.
- **Every half hour is about 1,440 Actions minutes a month.** Each run is billed by the minute.
  Every hour costs half, and hears of a failure up to 30 minutes later.

The other inputs are in [`health-watch/action.yml`](health-watch/action.yml): the route
(`health-path`), a page with the detail behind the project's session (`details-path`), and the
time zone of the times in a message (`time-zone`).

### 4. Try it

From GitHub, *Actions → Health watch → Run workflow*: `dry-run` prints both messages for what
fails at the given address, `test` posts a test alert to `#alerts`, and `watch` runs as the
schedule. *Actions → Deploy notices → Run workflow* tells about the deployment whose id it is
given: as a dry run, the notice is in the run's summary; without it, it posts to `#alerts`.

From a checkout of this repo, nothing is posted:

```bash
GITHUB_TOKEN="$(gh auth token)" PROJECT=Example PRODUCTION_URL=https://example.com TEST_URL=https://test.example.com \
  node deploy-notice/notify.ts --repo Always-Chasing/<repo> --deployment <id> --dry-run
GITHUB_TOKEN="$(gh auth token)" PROJECT=Example PRODUCTION_URL=https://example.com \
  node deploy-notice/notify.ts --repo Always-Chasing/<repo> --release <full SHA of a merge to main> --dry-run
PROJECT=Example PRODUCTION_URL=https://example.com \
  node health-watch/watch.ts --checks <path to the project's checks file> --dry-run --url https://<preview>.vercel.app
```

The id of a deployment comes from the list of an environment (`Production` or `staging`):

```bash
gh api "repos/Always-Chasing/<repo>/deployments?environment=Production&per_page=5" --jq '.[] | "\(.id) \(.sha[0:7]) \(.created_at)"'
```

## Check pull requests

`pr-rules` holds every pull request to the Git conventions, the same in every repo. A pull
request that breaks one fails its «Rules» check, with one message per broken rule that says
which rule and how to fix it.

| Rule | What it asks |
|---|---|
| Title | [Conventional Commits](https://www.conventionalcommits.org): `<type>(<scope>): <summary>`, such as `feat(auth): let a user reset their password`. Squash & Merge makes it the commit |
| Branch | `<prefix>/<slug>` for a task, `project/<slug>` for an umbrella, in lowercase words joined by hyphens, and never the issue's ID: the body links the issue |
| Base | The branch the flow expects for that kind of pull request, in the table below |
| Linear | A task or a hotfix links its issue with a magic word: `Completes DEV-123`, or `Part of DEV-123` when it does not finish it. A release completes every issue a pull request in it finishes — see [Draft the release](#draft-the-release) |

A pull request is told apart by its head branch, and the gate is the branch where someone outside
validates before production (`test`, `staging`):

| Kind | Head | Goes to, with a gate | Goes to, without one |
|---|---|---|---|
| Release | The gate | `main` | — |
| Umbrella | `project/<slug>` | The gate | `main` |
| Dependabot | `dependabot/…` | The gate | `main` |
| Hotfix | `hotfix/<slug>` | The gate | `main` |
| Task | Any other | Its umbrella, the branch it is stacked on, or the gate | Its umbrella, the branch it is stacked on, or `main` |

With `umbrella-only: true`, a task never goes straight to the gate: only through its umbrella.
An umbrella and a release may carry `Completes` lines, and in a team whose merge to `main` is
what moves an issue to Done they must: a pull request that gathers others does not inherit their
issues.

`.github/workflows/pull-request.yml`, with the project's values:

```yaml
name: Pull request

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions: {}

jobs:
  rules:
    name: Rules
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
      # Only a release reads anything: what it releases.
      pull-requests: read
    steps:
      - uses: Always-Chasing/always-chasing-toolkit/pr-rules@<full SHA of the version> # v1.2.0
        with:
          gate: test
```

A workflow of its own, apart from CI, because it has to run again when someone edits the title,
the body or the base, and nothing else needs to. It reads the pull request from the event: no
checkout and no secret. Only a release reads GitHub, with the job's own token.

| Input | Default | What it sets |
|---|---|---|
| `gate` | empty | The gate. Empty when pull requests go straight to `main` |
| `umbrella-only` | `false` | `true` when every task enters through its umbrella |
| `prefixes` | `feature bugfix qafix improvement hotfix refactor docs chore perf test` | The prefixes a task branch may take |
| `team-keys` | `DEV OPS INT` | The Linear teams a magic word may name, and whose IDs a branch may not carry |
| `github-token` | The job's token | Reads what a release releases |

| Project | `gate` | `umbrella-only` |
|---|---|---|
| Control Tower | `test` | `false` |
| ECO | `staging` | `true` |
| This toolkit | empty | `false`, with `team-keys: INT` |

**Make it required.** In the repo's ruleset for `main` and the gate, *Require status checks to
pass* → add `Rules` (GitHub Actions). Until then a red «Rules» warns and does not stop the merge.

From a checkout of this repo, against a real pull request or by hand:

```bash
GITHUB_TOKEN="$(gh auth token)" GATE=test node pr-rules/check.ts --repo Always-Chasing/<repo> --pr <number>
GATE=test PR_TITLE='feat: add it' PR_BRANCH=feature/add-it PR_BASE=test PR_BODY='Completes DEV-1' node pr-rules/check.ts
```

## Draft the release

In team DEV, entering the gate moves an issue to In Test, and **only the merge to `main` moves it
to Done**. A pull request that gathers others does not inherit their issues, so the release names
every issue that entered the gate since the previous release, one `Completes` line each. One
missing line, and that issue never reaches Done on its own.

`release-pr/draft.ts` writes that body. It reads what the gate has and `main` does not —
`git log origin/main..origin/test`—: each pull request squashed into the gate or into an umbrella
(`… (#N)`), and each umbrella that entered it (`Merge pull request #N from …`). From their bodies
it takes the magic words:

- **One row per pull request that entered the gate itself**: umbrellas, tasks, hotfixes and
  Dependabot. Its words come from the title; rewrite them as what production gets.
- **One `Completes` line per issue that some pull request finishes**, umbrellas and their tasks
  alike.
- **What only a `Part of` names stays open**, listed with bare IDs, which link nothing.

Then it compares that list with the issues of the team in In Test that a pull request of the repo
links, and says which differ: one the release completes that is not in In Test, or one in In Test
that no pull request completes. It exits with 1 when they differ, after writing the body.

From the project's checkout, with a clone of this repo beside it:

```bash
GITHUB_TOKEN="$(gh auth token)" \
LINEAR_API_KEY="$(security find-generic-password -s always-chasing-linear-api -w)" \
  node ~/projects/always-chasing-toolkit/release-pr/draft.ts --gate test > release.md
```

Then rewrite each row as what production gets, add what is worth knowing before production, and
open it:

```bash
gh pr create --base main --head test --title "chore: release … to production" --body-file release.md
```

| Option | Default | What it sets |
|---|---|---|
| `--gate` | `test` | The gate; ECO's is `staging` |
| `--repo` | The checkout's `origin` | The repo, as `<owner>/<name>` |
| `--team` | `DEV` | The team whose In Test it compares with |
| `--team-keys` | `DEV OPS INT` | The teams whose magic words count |

**The Linear key never leaves the Mac.** It is read from the Keychain into the command's
environment and goes only to Linear's API. Without it, the comparison is left out. A key of
Linear's with read access is enough.

**The «Rules» check holds the release to it.** `pr-rules` fails a release that does not complete
an issue some pull request in it finishes, reading GitHub with the job's token, and warns of one it
completes that no pull request finishes. It does not read Linear. An issue that should not reach
Done with this release is fixed where it was promised: edit the body of the pull request that
finished it to say `Part of`, and the check runs again on the next edit of the release.

## The Slack app and its webhook

One app for all the projects, **Mr.Chase** —the same name as Always Chasing's agent in Linear—,
created once from [`slack/app-manifest.yml`](slack/app-manifest.yml).
Go to api.slack.com/apps → *Create New App* → *From a manifest*, in the «Always Chasing»
workspace. Paste the manifest in the editor's *YAML* tab: the editor opens on JSON, and YAML
pasted there gives «Expecting 'STRING' … got 'INVALID'». The app holds no permission beyond its
webhook.

Then *Install to Workspace*. Slack asks for the webhook's channel —that step has no CLI, it is
the consent of whoever installs— and `#alerts` is the one. Whoever installs has to be in the
channel, because it is private. The address appears in *Incoming Webhooks*.

**The address is a secret: never in a repo, a chat, a log or a screenshot.** Copy it, and in
Terminal.app, from a checkout of this repo, test and save it without printing it. The command
posts a test alert with the copied address, and only if Slack takes it does it save the secret
and empty the clipboard. It runs only when the clipboard holds a Slack webhook: `gh` takes an
empty value without complaint, and a second run, with the clipboard already empty, would empty
the secret. Saving an organization secret needs the `admin:org` scope, once:
`gh auth refresh -h github.com -s admin:org`.

```bash
if pbpaste | grep -qxE 'https://hooks\.slack\.com/services/[A-Za-z0-9/]+'; then SLACK_WEBHOOK_URL="$(pbpaste)" PROJECT="Always Chasing" node health-watch/watch.ts --test && pbpaste | gh secret set SLACK_ALERTS_WEBHOOK_URL --org Always-Chasing --visibility selected --repos estrategia-urbana-control-tower,cabreras-eco && pbcopy < /dev/null; else echo 'The clipboard holds no Slack webhook: the secret was not touched'; fi
```

`--repos` sets the whole list of repos that see the secret. When the secret changes, list every
project that uses it, from the table above.

- **Rotate it:** add another webhook in the same app (*Incoming Webhooks → Add New Webhook*),
  save it with the same command, and revoke the old one.
- **Without the secret, a run fails** instead of keeping quiet: its log says why.
- **The scripts post to `hooks.slack.com` and nowhere else**, and the jobs read the repo and
  nothing more.

## Versions

Each release gets its exact version, such as `v1.2.0`, which never moves. `v1` moves with every
change that keeps the inputs and the behavior a project relies on; a change that breaks them is
`v2`.

Projects pin the full SHA of an exact version, with that version beside it, like any other action:
a tag can move, a SHA cannot. **Beside the SHA goes the exact version, never `v1`**: when `v1`
moves, a pin that says `v1` beside an older SHA stops being true, and zizmor's
`ref-version-mismatch` fails the project's CI. With the exact version, Dependabot proposes the next
one as a pull request.

```bash
git ls-remote https://github.com/Always-Chasing/always-chasing-toolkit 'refs/tags/v1.2.0^{}'
```

## Develop

```bash
npm ci
npm run check   # the types, then the tests
```

- **No runtime dependencies.** The actions run their TypeScript on plain Node 24, which strips
  the types itself, so nothing is installed on each run. Only erasable syntax works: no enums,
  no namespaces, no parameter properties. `tsconfig.json` refuses the rest.
- **Third-party actions pinned to a full commit SHA**, with the version beside it.
- **Every input reaches a script as environment**, never as part of a command.
- **The webhook is the one secret in Actions, and the Linear key the one on a Mac.** Nothing prints
  them: an error names the variable, never its value.
- **The messages are in English and start with the project's name.** The rules that write them
  are pure functions, tested on their own; the scripts ask, post and remember.
