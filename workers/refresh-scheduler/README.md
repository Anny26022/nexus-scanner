# Daily refresh trigger

Cloudflare checks at 4:00 PM and 4:10 PM IST, Monday–Friday, and dispatches the
existing daily GitHub workflow on `main`. The second check covers a failed initial
request or failed run. Successful, running or queued runs created since the daily
4 PM slot suppress another dispatch. An earlier manual run does not suppress the
after-close refresh. GitHub cron remains a fallback; its gate skips the expensive
pipeline if an earlier daily run already succeeded. Manual runs without the
`scheduled_refresh` input retain their normal behavior and full backup policy.

There are no storage bindings or public HTTP endpoint. GitHub is the run ledger.
The shared gate selects the earlier run when automatic triggers race; existing
workflow concurrency serializes runs. Network failures fail the trigger rather
than dispatching without checking. Failed runs can be retried by the second check
or the GitHub fallback. This improves trigger delivery, without guaranteeing an
exact runner start time.

## Activate after merging the workflow

Create a fine-grained GitHub token scoped only to `Anny26022/nexus-scanner`, with
repository **Actions: read and write** (metadata read is implicit). Deploy the
dedicated Worker and immediately store the token as its `GITHUB_TOKEN` secret:

```sh
wrangler deploy --config workers/refresh-scheduler/wrangler.jsonc
wrangler secret put GITHUB_TOKEN --config workers/refresh-scheduler/wrangler.jsonc
```

Do not reuse a local CLI login token or put tokens in committed files. Cron
configuration can take up to 15 minutes to propagate. A merge alone does not
activate the external scheduler; until deployment, the GitHub schedule remains
in effect. Inspect scheduled execution logs with:

```sh
wrangler tail nexus-refresh-scheduler
node --test workers/refresh-scheduler/test.mjs
```
