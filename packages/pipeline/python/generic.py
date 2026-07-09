"""Per-row genericness: how much a row resembles the rest of cinema.

Universal filler ("How is it? Horrible", greetings, arguments) sits near
everything in embedding space and wins raw-cosine matching everywhere it
appears, which is exactly what made the first bridge matches mush. Each
row's genericness is the mean similarity to its top-K nearest cross-film
rows; downstream ranking subtracts it so only distinctive resonance wins.
The same statistic serves beats (dialogue space) and scene summaries
(event space, where "two people argue" is the filler).

Exact all-pairs at full corpus is ~6e17 flops (a day of GPU), so the top-K
runs against a fixed random sample of the corpus instead. Generic rows have
thousands of near-neighbors and hit the sample everywhere; distinctive rows
miss it everywhere. The estimate preserves exactly the ordering the ranking
needs. Sample indexes are seeded, so runs are reproducible.

Usage:
    uv run generic.py --rows data/beats.jsonl --bin data/beat-embeddings.bin \
        --out data/beat-generic.bin
    uv run generic.py --rows data/summaries.jsonl \
        --bin data/summary-embeddings.bin --out data/summary-generic.bin
"""

import argparse
import json
from pathlib import Path

SEED = 42
SAMPLE = 10240
TOP_K = 32
CHUNK = 4096


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", required=True, type=Path)
    parser.add_argument("--bin", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    import numpy as np
    import torch

    meta = json.loads(args.bin.with_suffix(".meta.json").read_text())
    dim = int(meta["dim"])
    count = int(meta["count"])

    movie_ids = np.empty(count, dtype=np.int64)
    with args.rows.open() as f:
        for i, line in enumerate(f):
            movie_ids[i] = json.loads(line)["movieId"]
    if i + 1 != count:
        raise SystemExit(f"rows jsonl has {i + 1} rows, meta says {count}")

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"genericness on {device}: {count} rows, sample {SAMPLE}, top {TOP_K}", flush=True)

    vectors = np.memmap(args.bin, dtype="<f4", mode="r", shape=(count, dim))
    rng = np.random.default_rng(SEED)
    sample_idx = rng.choice(count, size=min(SAMPLE, count), replace=False)
    sample = torch.from_numpy(np.ascontiguousarray(vectors[sample_idx])).to(device).half()
    sample_movies = torch.from_numpy(movie_ids[sample_idx]).to(device)

    raw = np.empty(count, dtype=np.float32)
    movies_t = torch.from_numpy(movie_ids).to(device)
    for start in range(0, count, CHUNK):
        end = min(start + CHUNK, count)
        chunk = torch.from_numpy(np.ascontiguousarray(vectors[start:end])).to(device).half()
        sims = chunk @ sample.T
        # Own-film pairs (including self) do not count toward genericness.
        same = movies_t[start:end].unsqueeze(1) == sample_movies.unsqueeze(0)
        sims.masked_fill_(same, -1.0)
        top = sims.topk(TOP_K, dim=1).values.float().mean(dim=1)
        raw[start:end] = top.cpu().numpy()
        if (start // CHUNK) % 20 == 0:
            print(f"{end}/{count}", flush=True)

    lo, hi = float(raw.min()), float(raw.max())
    normalized = (raw - lo) / max(hi - lo, 1e-9)
    normalized.astype("<f4").tofile(args.out)
    args.out.with_suffix(".meta.json").write_text(
        json.dumps({"count": count, "sample": int(len(sample_idx)), "k": TOP_K})
    )
    q = np.quantile(normalized, [0.1, 0.5, 0.9])
    print(f"done: p10 {q[0]:.3f}, p50 {q[1]:.3f}, p90 {q[2]:.3f}")


if __name__ == "__main__":
    main()
