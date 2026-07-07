"""Embed utterances on the Apple GPU (MPS) with sentence-transformers.

Produces the same artifacts as the transformers.js embed stage: a flat
Float32 little-endian matrix row-aligned with the input jsonl, a meta json,
and a progress checkpoint that makes the run resumable. Passages are encoded
without any instruction prefix and L2-normalized, matching the js stage.

Usage:
    uv run embed.py --input ../data/utterances.jsonl --output ../data/embeddings.bin
    uv run embed.py --model BAAI/bge-base-en-v1.5 ...   # phase 5 tier
"""

import argparse
import json
import sys
import time
from pathlib import Path


def read_texts(path: Path) -> list[str]:
    texts = []
    with path.open() as f:
        for line in f:
            texts.append(json.loads(line)["text"])
    return texts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    parser.add_argument(
        "--pooling",
        choices=["mean", "cls"],
        default="mean",
        help="mean matches the transformers.js stage and the web query encoder; "
        "bge's official recipe is cls. The whole corpus and all query paths must agree.",
    )
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--checkpoint-every", type=int, default=40, help="batches")
    parser.add_argument("--limit", type=int, default=0, help="stop after N rows (benchmarks)")
    args = parser.parse_args()

    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    if device == "cpu":
        print("warning: no MPS device, running on CPU (expect ~4x slower)", flush=True)
    print(f"embedding on {device}", flush=True)
    model = SentenceTransformer(args.model, device=device)
    pooling = model[1]
    pooling.pooling_mode_cls_token = args.pooling == "cls"
    pooling.pooling_mode_mean_tokens = args.pooling == "mean"
    dim = model.get_sentence_embedding_dimension()

    texts = read_texts(args.input)
    if args.limit:
        texts = texts[: args.limit]
    total = len(texts)

    progress_path = args.output.with_suffix(".progress.json")
    meta_path = args.output.with_suffix(".meta.json")

    done = 0
    if progress_path.exists() and args.output.exists():
        done = json.loads(progress_path.read_text())["rows"]
        expected = done * dim * 4
        actual = args.output.stat().st_size
        if actual < expected:
            print(f"progress claims {done} rows but bin has fewer bytes; restart", file=sys.stderr)
            sys.exit(1)
        # Truncate any partial tail past the checkpoint.
        with args.output.open("r+b") as f:
            f.truncate(expected)
        print(f"resuming from row {done}")

    mode = "r+b" if done else "wb"
    started = time.time()
    written = done
    with args.output.open(mode) as out:
        out.seek(done * dim * 4)
        batch_index = 0
        for start in range(done, total, args.batch):
            chunk = texts[start : start + args.batch]
            vectors = model.encode(
                chunk,
                batch_size=args.batch,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            out.write(vectors.astype("<f4").tobytes())
            written += len(chunk)
            batch_index += 1
            if batch_index % args.checkpoint_every == 0:
                out.flush()
                progress_path.write_text(json.dumps({"rows": written}))
                rate = (written - done) / (time.time() - started)
                print(f"{written}/{total} ({rate:.0f}/s)", flush=True)

    progress_path.write_text(json.dumps({"rows": written}))
    meta_path.write_text(json.dumps({"model": args.model, "dim": dim, "count": written}))
    rate = (written - done) / max(time.time() - started, 1e-9)
    print(f"done: {written} rows at {rate:.0f}/s on {device}")
    progress_path.unlink()


if __name__ == "__main__":
    main()
