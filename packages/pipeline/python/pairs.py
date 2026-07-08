"""Movie vectors and movie pair similarity from segment embeddings.

For each film pair the score is a baseline-normalized best match over segment
sets: every segment scores its best cosine against the other film, minus that
segment's mean best across all films, so dialogue that matches everything
contributes nothing. The blend folds in TMDb metadata similarity so era and
genre still count. Symmetric, top 12 kept per film.

Usage:
    uv run pairs.py --data ../data
"""

import argparse
import json
from pathlib import Path

import numpy as np

GENRE_WEIGHT = 0.5
DECADE_WEIGHT = 0.2
KEYWORD_WEIGHT = 0.3
DECADE_SPAN_YEARS = 40
SEGMENT_BLEND = 0.7
TOP_K = 12


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def tmdb_similarity(a: dict, b: dict) -> float:
    genre = jaccard(set(a["genreIds"]), set(b["genreIds"]))
    decade = max(0.0, 1 - abs(a["decade"] - b["decade"]) / DECADE_SPAN_YEARS)
    keyword = jaccard(set(a["keywordIds"]), set(b["keywordIds"]))
    total = GENRE_WEIGHT + DECADE_WEIGHT + KEYWORD_WEIGHT
    return (GENRE_WEIGHT * genre + DECADE_WEIGHT * decade + KEYWORD_WEIGHT * keyword) / total


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("../data"))
    args = parser.parse_args()

    meta = json.loads((args.data / "segment-embeddings.meta.json").read_text())
    dim, count = meta["dim"], meta["count"]
    matrix = np.fromfile(args.data / "segment-embeddings.bin", dtype=np.float32)
    matrix = matrix.reshape(count, dim)

    seg_film = []
    with (args.data / "segments.jsonl").open() as f:
        for line in f:
            seg_film.append(json.loads(line)["movieId"])
    seg_film = np.array(seg_film)
    film_ids = sorted(set(seg_film.tolist()))
    film_index = {movie_id: i for i, movie_id in enumerate(film_ids)}
    n_films = len(film_ids)
    print(f"{count} segments across {n_films} films", flush=True)

    movies = {
        m["id"]: m
        for m in json.loads((args.data / "movies.json").read_text())
        if m["id"] in film_index
    }

    # Movie vectors: normalized mean of the film's segment vectors.
    movie_vecs = np.zeros((n_films, dim), dtype=np.float32)
    for movie_id in film_ids:
        rows = matrix[seg_film == movie_id]
        vec = rows.mean(axis=0)
        movie_vecs[film_index[movie_id]] = vec / (np.linalg.norm(vec) or 1.0)
    movie_vecs.tofile(args.data / "movie-vectors.bin")
    (args.data / "movie-vectors.meta.json").write_text(
        json.dumps({"dim": dim, "count": n_films, "movieIds": film_ids})
    )

    # best[s, f]: segment s's best cosine against film f, in film-sized blocks
    # so memory stays bounded. Baseline is the segment's mean best across all
    # other films; a segment's own film is excluded from both.
    best = np.zeros((count, n_films), dtype=np.float32)
    for movie_id in film_ids:
        mask = seg_film == movie_id
        sims = matrix @ matrix[mask].T
        best[:, film_index[movie_id]] = sims.max(axis=1)
    own = np.array([film_index[m] for m in seg_film])
    best[np.arange(count), own] = np.nan
    baseline = np.nanmean(best, axis=1, keepdims=True)
    centered = best - baseline

    # score(A, B) = mean over A's segments of centered best match against B.
    seg_scores = np.zeros((n_films, n_films), dtype=np.float32)
    for movie_id in film_ids:
        rows = centered[seg_film == movie_id]
        seg_scores[film_index[movie_id]] = np.nanmean(rows, axis=0)
    seg_scores = (seg_scores + seg_scores.T) / 2
    np.fill_diagonal(seg_scores, np.nan)

    # Normalize the segment scores into roughly [0, 1] before blending.
    finite = seg_scores[np.isfinite(seg_scores)]
    lo, hi = np.percentile(finite, [1, 99])
    seg_norm = np.clip((seg_scores - lo) / (hi - lo or 1.0), 0, 1)

    pairs = {}
    for movie_id in film_ids:
        i = film_index[movie_id]
        blended = []
        for other_id in film_ids:
            j = film_index[other_id]
            if i == j:
                continue
            score = SEGMENT_BLEND * float(seg_norm[i, j]) + (1 - SEGMENT_BLEND) * tmdb_similarity(
                movies[movie_id], movies[other_id]
            )
            blended.append((score, other_id))
        blended.sort(reverse=True)
        pairs[str(movie_id)] = [
            {"id": other_id, "score": round(score, 4)} for score, other_id in blended[:TOP_K]
        ]

    (args.data / "movie-pairs.json").write_text(json.dumps(pairs))
    print(f"wrote movie-pairs.json for {n_films} films", flush=True)


if __name__ == "__main__":
    main()
