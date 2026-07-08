"""Reconcile an embedding matrix against a changed jsonl: copy vectors for
rows whose text is unchanged, embed only the rest.

Cleaning tweaks touch a few percent of utterances; re-embedding all 3.8M rows
for that wastes half an hour of GPU. Unchanged text embeds to the same vector,
so rows are matched by exact text (first occurrence wins on duplicates), the
matched vectors are copied byte for byte, and only new or edited rows go
through the model. The output is row-aligned with the new jsonl, identical to
what a full embed run would produce.

Usage:
    uv run reconcile.py --old-jsonl data/utterances.prev.jsonl \
        --old-bin data/embeddings.prev.bin \
        --new-jsonl data/utterances.jsonl --out-bin data/embeddings.bin

The old bin's sibling meta json names the model; the run refuses to mix
models. A final spot check re-encodes 5 copied and 5 fresh rows and requires
cosine agreement of at least 0.9999.

Work happens in a file-backed .partial sibling with progress checkpointed
every few batches, so a killed run resumes where it left off instead of
starting over; the out bin only appears once the spot check passes.
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
    parser.add_argument("--old-jsonl", required=True, type=Path)
    parser.add_argument("--old-bin", required=True, type=Path)
    parser.add_argument("--new-jsonl", required=True, type=Path)
    parser.add_argument("--out-bin", required=True, type=Path)
    parser.add_argument("--model", default=None, help="defaults to the old bin's meta")
    parser.add_argument("--pooling", choices=["mean", "cls"], default="mean")
    parser.add_argument("--batch", type=int, default=256)
    args = parser.parse_args()

    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    old_meta_path = args.old_bin.with_suffix(".meta.json")
    if not old_meta_path.exists():
        print(f"missing {old_meta_path}; reconcile needs the old run's meta", file=sys.stderr)
        sys.exit(1)
    old_meta = json.loads(old_meta_path.read_text())
    model_name = args.model or old_meta["model"]
    if model_name != old_meta["model"]:
        print(
            f"old bin was embedded with {old_meta['model']}, requested {model_name}; "
            "a model change needs a full embed run, not a reconcile",
            file=sys.stderr,
        )
        sys.exit(1)
    dim = int(old_meta["dim"])

    old_texts = read_texts(args.old_jsonl)
    new_texts = read_texts(args.new_jsonl)
    if len(old_texts) != int(old_meta["count"]):
        print(
            f"old jsonl has {len(old_texts)} rows but meta says {old_meta['count']}; "
            "the pair does not belong together",
            file=sys.stderr,
        )
        sys.exit(1)

    old_index: dict[str, int] = {}
    for i, text in enumerate(old_texts):
        if text not in old_index:
            old_index[text] = i

    old = np.memmap(args.old_bin, dtype="<f4", mode="r", shape=(len(old_texts), dim))

    total = len(new_texts)
    fresh_rows = [i for i, text in enumerate(new_texts) if text not in old_index]
    copied = total - len(fresh_rows)
    print(f"{total} rows: {copied} copied, {len(fresh_rows)} to embed", flush=True)

    partial = args.out_bin.with_name(args.out_bin.name + ".partial")
    progress_path = args.out_bin.with_suffix(".progress.json")
    fingerprint = {
        "model": model_name,
        "dim": dim,
        "total": total,
        "fresh": len(fresh_rows),
        "new_jsonl_bytes": args.new_jsonl.stat().st_size,
    }

    embedded = 0
    if progress_path.exists() and partial.exists():
        saved = json.loads(progress_path.read_text())
        if (
            saved.get("fingerprint") == fingerprint
            and partial.stat().st_size == total * dim * 4
        ):
            embedded = int(saved["embedded"])
            print(f"resuming: {embedded}/{len(fresh_rows)} fresh rows already embedded", flush=True)

    resume = embedded > 0
    out = np.memmap(partial, dtype="<f4", mode="r+" if resume else "w+", shape=(total, dim))
    if not resume:
        for i, text in enumerate(new_texts):
            j = old_index.get(text)
            if j is not None:
                out[i] = old[j]
        out.flush()
        progress_path.write_text(json.dumps({"fingerprint": fingerprint, "embedded": 0}))

    if fresh_rows:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        print(f"embedding {len(fresh_rows)} fresh rows on {device}", flush=True)
        model = SentenceTransformer(model_name, device=device)
        pooling = model[1]
        pooling.pooling_mode_cls_token = args.pooling == "cls"
        pooling.pooling_mode_mean_tokens = args.pooling == "mean"
        started = time.time()
        for start in range(embedded, len(fresh_rows), args.batch):
            rows = fresh_rows[start : start + args.batch]
            vectors = model.encode(
                [new_texts[i] for i in rows],
                batch_size=args.batch,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            out[rows] = vectors.astype("<f4")
            done = start + len(rows)
            if (start // args.batch) % 10 == 0 or done == len(fresh_rows):
                out.flush()
                progress_path.write_text(json.dumps({"fingerprint": fingerprint, "embedded": done}))
                if device == "mps":
                    # The MPS caching allocator grows without bound on
                    # varying-length batches; drop it or the kernel drops us.
                    torch.mps.empty_cache()
                rate = (done - embedded) / max(time.time() - started, 1e-9)
                print(f"{done}/{len(fresh_rows)} ({rate:.0f}/s)", flush=True)
    else:
        model = None

    out.flush()

    # Spot check: re-encode a handful of copied and fresh rows directly.
    if model is None:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        model = SentenceTransformer(model_name, device=device)
        pooling = model[1]
        pooling.pooling_mode_cls_token = args.pooling == "cls"
        pooling.pooling_mode_mean_tokens = args.pooling == "mean"
    copied_rows = [i for i, text in enumerate(new_texts) if text in old_index]
    step = max(1, len(copied_rows) // 5)
    probe = copied_rows[::step][:5] + fresh_rows[:: max(1, len(fresh_rows) // 5)][:5]
    if probe:
        expected = model.encode(
            [new_texts[i] for i in probe],
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        worst = 1.0
        for k, i in enumerate(probe):
            cosine = float(np.dot(out[i], expected[k]))
            worst = min(worst, cosine)
        print(f"spot check: {len(probe)} rows, worst cosine {worst:.6f}")
        if worst < 0.9999:
            print("spot check FAILED; do not trust this bin", file=sys.stderr)
            sys.exit(1)

    del out
    partial.replace(args.out_bin)
    args.out_bin.with_suffix(".meta.json").write_text(
        json.dumps({"model": model_name, "dim": dim, "count": total})
    )
    progress_path.unlink(missing_ok=True)
    print(f"done: {copied} copied, {len(fresh_rows)} embedded")


if __name__ == "__main__":
    main()
