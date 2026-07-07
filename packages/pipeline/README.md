# Pipeline

Offline data pipeline. Each stage is a standalone script that reads and writes artifacts under `data/` (gitignored) so any stage can be re-run in isolation. Stages run offline against the on-disk HTTP cache; network access requires `ALLOW_NETWORK=1` so a bug can never turn into a crawl.

## Stages

Run from this package with `pnpm exec tsx src/stages/<stage>.ts`, in order:

| Stage        | Reads                                    | Writes                                            |
| ------------ | ---------------------------------------- | ------------------------------------------------- |
| `slice`      | `movies.json`, `scripts.json`            | `slice.json` (film ids, top 300 by TMDb votes)    |
| `extract`    | `slice.json`, HTTP cache                 | `cues.jsonl`, `extract-report.json`               |
| `utterances` | `cues.jsonl`                             | `utterances.jsonl`, `utterances-report.json`      |
| `embed`      | `utterances.jsonl`                       | `embeddings.bin`, `embeddings.meta.json`          |
| `load`       | artifacts above                          | ClickHouse tables (staging swap)                  |

## Artifact formats

- `cues.jsonl`: `{movieId, idx, text}` per line, ordered by film then cue index. One cue is one subtitle fragment from the transcript page, tags stripped, raw content kept.
- `utterances.jsonl`: `{movieId, seq, arc, text}` per line, ordered by film then seq. An utterance is a reconstructed spoken line: dash-marked speaker turns split apart, mid-sentence cue breaks merged, stage directions and lyrics removed, subtitle OCR damage repaired. `arc` is the film position, 0 to 1.
- `embeddings.bin`: little-endian Float32 rows, L2-normalized, row-aligned with `utterances.jsonl` line order. `embeddings.meta.json` records model, dim, and count. `embeddings.progress.json` exists only mid-run; the embed stage resumes from it after a crash.

## Extraction notes

Transcripts come from the cached Springfield! Springfield! pages (SHA1-of-URL keys under `data/cache/http/`). The lookup replays the site's search to find each film's slug, checks the year, then splits the `scrolling-script-container` div on `<br>` boundaries. Cues are display fragments, not lines; see `src/util/utterances.ts` for the reconstruction rules and `test/` for their specification.
