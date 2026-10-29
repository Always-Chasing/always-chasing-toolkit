# Always Chasing Toolkit

GitHub actions that every Always Chasing project reuses. Today it holds two Slack alerts for
projects on Vercel and Supabase. Both post to `#alerts`, the private channel of the «Always
Chasing» Slack, through one app, Mr.Chase:

| Action | What it tells |
|---|---|
| [`deploy-notice`](deploy-notice/action.yml) | Whether a deploy of `test` or production went live: Vercel's build, Supabase's migrations, and whether the domain already serves the new version. When it did not go live, it says why |
| [`health-watch`](health-watch/action.yml) | What started failing in production, read from the project's `/api/health` every half hour, and a reminder every 6 hours while it keeps failing. It also speaks when production does not answer at all |

All the projects post through the same app, so **every message starts with the project's name**.
The messages are in English.

The repo is public, and holds nothing but code: the webhook lives in each organization's
secrets, never here. Being public is what lets every project use it as it uses any other action:
the security audits of its CI can read it, and Dependabot can tell when a new version is out.

## Projects that use it

| Project | Repo |
|---|---|
| Control Tower | `Always-Chasing/estrategia-urbana-control-tower` |

## Add a project

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
      - uses: Always-Chasing/always-chasing-toolkit/deploy-notice@<full SHA of v1> # v1
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
      - uses: Always-Chasing/always-chasing-toolkit/deploy-notice@<full SHA of v1> # v1
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
      - uses: Always-Chasing/always-chasing-toolkit/health-watch@<full SHA of v1> # v1
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
if pbpaste | grep -qxE 'https://hooks\.slack\.com/services/[A-Za-z0-9/]+'; then SLACK_WEBHOOK_URL="$(pbpaste)" PROJECT="Always Chasing" node health-watch/watch.ts --test && pbpaste | gh secret set SLACK_ALERTS_WEBHOOK_URL --org Always-Chasing --visibility selected --repos estrategia-urbana-control-tower && pbcopy < /dev/null; else echo 'The clipboard holds no Slack webhook: the secret was not touched'; fi
```

`--repos` sets the whole list of repos that see the secret. When the secret changes, list every
project that uses it, from the table above.

- **Rotate it:** add another webhook in the same app (*Incoming Webhooks → Add New Webhook*),
  save it with the same command, and revoke the old one.
- **Without the secret, a run fails** instead of keeping quiet: its log says why.
- **The scripts post to `hooks.slack.com` and nowhere else**, and the jobs read the repo and
  nothing more.

## Versions

`v1` moves with every change that keeps the inputs and the behavior a project relies on. A change
that breaks them is `v2`. Projects pin the full SHA of the version, with the version beside it,
like any other action: a tag can move, a SHA cannot.

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
- **The webhook is the one secret.** Nothing prints it: an error names the variable, never its
  value.
- **The messages are in English and start with the project's name.** The rules that write them
  are pure functions, tested on their own; the scripts ask, post and remember.
