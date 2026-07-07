"""Check that two embedding runtimes agree before trusting a new one.

Compares row-aligned Float32 matrices by per-row cosine over the first N
rows. Different runtimes (onnx vs torch, cpu vs mps) legitimately differ in
the last few decimal places; anything below the threshold means a real
mismatch (wrong pooling, wrong normalization, wrong model revision).

Usage:
    uv run validate.py --a ../data/embeddings.bin --b /tmp/sample.bin --dim 384 --rows 1000
"""

import argparse
from pathlib import Path

import numpy as np

PASS_THRESHOLD = 0.999


def load(path: Path, dim: int, rows: int) -> np.ndarray:
    data = np.fromfile(path, dtype="<f4", count=rows * dim)
    if data.size < rows * dim:
        raise SystemExit(f"{path} holds fewer than {rows} rows")
    return data.reshape(rows, dim)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", required=True, type=Path)
    parser.add_argument("--b", required=True, type=Path)
    parser.add_argument("--dim", type=int, default=384)
    parser.add_argument("--rows", type=int, default=1000)
    args = parser.parse_args()

    a = load(args.a, args.dim, args.rows)
    b = load(args.b, args.dim, args.rows)
    # Rows are already L2-normalized; cosine is the dot product.
    cosines = np.sum(a * b, axis=1)
    print(f"rows: {args.rows}  min: {cosines.min():.6f}  mean: {cosines.mean():.6f}")
    if cosines.min() < PASS_THRESHOLD:
        worst = int(np.argmin(cosines))
        raise SystemExit(f"FAIL: row {worst} cosine {cosines.min():.6f} < {PASS_THRESHOLD}")
    print("PASS")


if __name__ == "__main__":
    main()
