# Pipeline

Offline data pipeline. Each stage is a standalone script that reads and writes artifacts under `data/` (gitignored) so any stage can be re-run in isolation. Stages run offline against the on-disk HTTP cache; network access requires `ALLOW_NETWORK=1` so a bug can never turn into a crawl.

## Stages

Run from this package with `pnpm exec tsx src/stages/<stage>.ts`, in order:

| Stage        | Reads                             | Writes                                                       |
| ------------ | --------------------------------- | ------------------------------------------------------------ |
| `slice`      | `movies.json`, `scripts.json`     | `slice.json` (top 300 by votes; `FULL=1` selects every film) |
| `extract`    | `slice.json`, HTTP cache          | `cues.jsonl`, `extract-report.json`                          |
| `utterances` | `cues.jsonl`, `cues-rescue.jsonl` | `utterances.jsonl`, `utterances-report.json`, `quality.json` |
| `embed`      | `utterances.jsonl`                | `embeddings.bin`, `embeddings.meta.json`                     |
| `load`       | artifacts above                   | ClickHouse tables (staging swap)                             |

For `embed`, the GPU embedder under `python/` is the default for corpus-scale runs (3.4x faster; see the GPU embedder section). The js stage is the reference implementation: it shares runtime and recipe with the web app's query encoder, defines the encoding every other path is validated against, and keeps the pipeline runnable where Python or Metal is unavailable.

## Artifact formats

- `cues.jsonl`: `{movieId, idx, text}` per line, ordered by film then cue index. One cue is one subtitle fragment from the transcript page, tags stripped, raw content kept.
- `utterances.jsonl`: `{movieId, seq, arc, text}` per line, ordered by film then seq. An utterance is a reconstructed spoken line: dash-marked speaker turns split apart, mid-sentence cue breaks merged, stage directions and lyrics removed, subtitle OCR damage repaired. `arc` is the film position, 0 to 1.
- `embeddings.bin`: little-endian Float32 rows, L2-normalized, row-aligned with `utterances.jsonl` line order. `embeddings.meta.json` records model, dim, and count. `embeddings.progress.json` exists only mid-run; the embed stage resumes from it after a crash.

## Extraction notes

Transcripts come from the cached Springfield! Springfield! pages (SHA1-of-URL keys under `data/cache/http/`). The lookup replays the site's search to find each film's slug, checks the year, then splits the `scrolling-script-container` div on `<br>` boundaries. A rare page variant has no `<br>` structure at all; those films fall back to sentence splitting with inline speaker names removed and are listed under `fallbackFilms` in `extract-report.json`. Cues are display fragments, not lines; see `src/util/utterances.ts` for the reconstruction rules and `test/` for their specification.

Quality: every film gets a transcript health score (punctuation density, dictionary hit rate, OCR artifact rate) written to `quality.json`; the worst decile carries a `downrank` flag and wrong-language transcripts a `nonEnglish` flag for downstream ranking. Lyrics are dropped by run detection around music-marked cues (wider windows for Music-genre films). Sources that mark no lyrics at all still slip through; those films land in the downranked tail.

## GPU embedder

`python/embed.py` is a sentence-transformers port of the embed stage that runs on the Apple GPU (MPS). Same artifacts, same row alignment, resumable the same way. Use it for full-corpus runs and the 768d phase; the transformers.js stage remains the reference implementation and the source of the web app's query encoding.

```bash
cd python
uv sync
uv run embed.py --input ../data/utterances.jsonl --output ../data/embeddings.bin
```

Two rules before trusting any new runtime or model change:

- Pooling must stay `mean` everywhere. bge's official recipe is CLS pooling, but the corpus and the web query encoder were built on mean pooling and every path must agree. `--pooling` exists for deliberate, corpus-wide migrations only.
- Run `uv run validate.py --a <reference.bin> --b <candidate.bin> --rows 1000` and require PASS (per-row cosine at least 0.999) before shipping vectors from a new runtime.
