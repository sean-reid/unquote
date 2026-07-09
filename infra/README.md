# Infra

Everything needed to run unquote.dwainosaur.com on one VPS: ClickHouse, the
SvelteKit app, and Caddy, all under Docker Compose. All server data is derived
from local pipeline artifacts, so there are no backups; a lost box is rebuilt
with `resurrect.sh` in under an hour.

## Files

| Path                       | What it is                                                        |
| -------------------------- | ----------------------------------------------------------------- |
| `docker-compose.yml`       | Local dev ClickHouse only (`pnpm db:up`)                          |
| `docker-compose.prod.yml`  | The production stack                                              |
| `docker-compose.local.yml` | Override to test the prod stack on a laptop (Caddy on :8080)      |
| `Caddyfile`                | TLS, security headers, compression, asset caching                 |
| `clickhouse/config.d/`     | Memory cap and system log trimming                                |
| `clickhouse/initdb/`       | First-boot users: `app` (read + analytics insert), `loader` (all) |
| `ops/`                     | Provision, deploy, data push, disk watch, full rebuild            |

## First provision

Two commands. The only human parts are the netcup checkout and pasting two
tokens into `.env`.

1. Buy the box: netcup VPS 2000 G12 (8 vCPU / 16 GB / 512 GB NVMe), location
   Manassas (US). Whatever OS it ships with is fine; provisioning reinstalls it.
2. Fill in `.env` at the repo root (gitignored):
   - `NETCUP_SCP_USER`: your CCP customer number
   - `NETCUP_SCP_TOKEN`: SCP top bar > API menu > create token
   - `SERVER_ID`: shown in the SCP (the script lists candidates if unset)
   - `CLOUDFLARE_API_TOKEN`: scoped to Zone > DNS > Edit on dwainosaur.com
3. Review the plan, then run it:

```bash
infra/ops/provision-netcup.sh            # dry run, prints the full plan
infra/ops/provision-netcup.sh --execute  # uploads the deploy key, reinstalls
                                         # Ubuntu 24.04 with setup.sh as the
                                         # bootstrap, points DNS, prints handoff
```

The script is idempotent: every step checks before acting (existing key
reused, running reinstall task resumed, DNS updated in place), so rerunning
after any failure continues where things stand. The reinstall step shows the
target server and requires typing its id back before anything destructive.
A DNS record pointing at a different IP needs `--force`.

4. Finish per the printed handoff: server `.env` secrets, `deploy.sh`,
   `push-data.sh`, the UptimeRobot check, and Cloudflare SSL "Full (strict)".
   The certificate escape hatch: if first issuance fails behind the proxy,
   gray-cloud the record, deploy, re-enable.

Mock-tested end to end without touching real APIs:
`infra/ops/test/provision-test.sh` (happy path both modes plus bad-token,
existing-key, and DNS-conflict scenarios against `test/mock-api.js`).

### Continuous deploys (optional)

`.github/workflows/deploy.yml` ships main to the server on every push once
you opt in: set repository secrets `SSH_PRIVATE_KEY` (the deploy key) and
`DEPLOY_HOST` (`root@<ip>`), then set the repository variable
`DEPLOY_ENABLED` to `true`. Until then the workflow is inert.

## Day to day

- Ship code: `UNQUOTE_HOST=... infra/ops/deploy.sh` (server pulls main and
  rebuilds; the web image bakes in the model weights so boot is instant).
- Ship data: rerun the pipeline locally, then `UNQUOTE_HOST=... infra/ops/push-data.sh`.
  The push loads staging tables and swaps atomically; the site never serves a
  partial corpus. Analytics tables live outside the swap and survive reloads.
- Disaster: `UNQUOTE_HOST=root@<new-ip> infra/ops/resurrect.sh` and move DNS.

## Edge cache

Three Cloudflare cache rules (Rulesets API, `http_request_cache_settings`
phase, managed with `CLOUDFLARE_API_TOKEN` which carries Zone > Cache Rules >
Edit) shape what the CDN may keep:

- `/_app/immutable/*`: cache, edge TTL one year. The filenames are
  content-hashed, so a deploy changes the URL rather than the content and no
  purge is ever needed.
- `/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png`: cache, edge TTL
  one day.
- Everything else: never cache. Pageviews are logged server-side for every
  HTML response and searches inside `/api/search`, so a cached page or API hit
  would silently drop analytics. This rule makes that constraint structural
  instead of relying on Cloudflare's defaults.

## Notes

- ClickHouse is never exposed publicly: port 8123 binds to the server's
  localhost only, and data pushes ride SSH.
- The web app connects as the `app` user, which can read `unquote.*` and insert
  only into `search_log` and `pageviews`.
- The DDL in `ops/push-data.sh` mirrors `packages/pipeline/src/stages/load.ts`;
  change them together.
- Docker log rotation, unattended security upgrades, UFW, and an hourly disk
  check are installed by `setup.sh`.
