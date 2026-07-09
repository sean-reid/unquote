# Unquote

Search the dialogue of ~2,600 films. Type a quote, a quote you only half remember, a scene you can describe but can't place, or just a movie title. Unquote finds the line, shows you the moment around it, and can tell you what else in cinema that moment resembles.

## Structure

This is a pnpm + Turborepo monorepo.

| Path                | What it is                                                               |
| ------------------- | ------------------------------------------------------------------------ |
| `apps/web`          | SvelteKit front end and API (server routes query ClickHouse directly)    |
| `packages/shared`   | Shared types and pure logic (text normalization, query handling)         |
| `packages/pipeline` | Offline data pipeline: fetch, parse, segment, embed, and load the corpus |
| `infra`             | ClickHouse compose file, deploy and ops scripts                          |

## Getting started

```bash
pnpm install
pnpm db:up      # local ClickHouse in Docker
pnpm dev        # dev server
pnpm test       # unit tests
pnpm e2e        # Playwright end to end
pnpm build      # production build
```

## Data

Films and metadata come from TMDb. Dialogue is parsed from publicly available transcripts, embedded at several context sizes (line, exchange, scene, film), and stored in ClickHouse for search and similarity queries. See `packages/pipeline` for the full flow.

## Attribution

This product uses the TMDb API but is not endorsed or certified by TMDb.

## License

MIT
