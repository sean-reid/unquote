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

1. Netcup checkout: a VPS with 8 vCPU / 16 GB / 512 GB NVMe in the Manassas (US)
   location, Ubuntu 24.04 LTS image, and your SSH public key. Any equivalent
   box from another provider works the same way.
2. Cloudflare DNS for dwainosaur.com: add an A record `unquote` pointing at the
   server IP, proxied. Set SSL mode to "Full (strict)". If certificate issuance
   fails on the very first deploy, gray-cloud the record, deploy, then re-enable
   the proxy: the ACME HTTP challenge usually passes through fine, but that is
   the escape hatch.
3. On the server, as root:
   `curl -fsSL https://raw.githubusercontent.com/sean-reid/unquote/main/infra/ops/setup.sh | bash`
4. `cp /opt/unquote/infra/.env.example /opt/unquote/infra/.env` and fill in
   three long random secrets (`openssl rand -hex 24` each).
5. From the laptop: `UNQUOTE_HOST=root@<ip> infra/ops/deploy.sh`
6. From the laptop, with the local ClickHouse running and loaded:
   `UNQUOTE_HOST=root@<ip> infra/ops/push-data.sh`
7. Uptime monitor: add an HTTPS check for `https://unquote.dwainosaur.com/` at
   UptimeRobot (free tier) with email alerts.

## Day to day

- Ship code: `UNQUOTE_HOST=... infra/ops/deploy.sh` (server pulls main and
  rebuilds; the web image bakes in the model weights so boot is instant).
- Ship data: rerun the pipeline locally, then `UNQUOTE_HOST=... infra/ops/push-data.sh`.
  The push loads staging tables and swaps atomically; the site never serves a
  partial corpus. Analytics tables live outside the swap and survive reloads.
- Disaster: `UNQUOTE_HOST=root@<new-ip> infra/ops/resurrect.sh` and move DNS.

## Notes

- ClickHouse is never exposed publicly: port 8123 binds to the server's
  localhost only, and data pushes ride SSH.
- The web app connects as the `app` user, which can read `unquote.*` and insert
  only into `search_log` and `pageviews`.
- The DDL in `ops/push-data.sh` mirrors `packages/pipeline/src/stages/load.ts`;
  change them together.
- Docker log rotation, unattended security upgrades, UFW, and an hourly disk
  check are installed by `setup.sh`.
