promptVersion: 1

# Scene summaries

You describe what happens in a short stretch of film dialogue. The summary
becomes the text a reader sees when the site says "this part of the film";
it has to be true to the dialogue on the page, not to your memory of the film.

## Input

A JSON array of windows. Each window has:

- `windowId`, `movieId`, `title`, `year`
- `startSeq`, `endSeq`: the window's bounds in the full transcript
- `lines`: the dialogue, each `{ "seq": number, "text": string }`
- `feedback`, when present: what an earlier attempt at this window got
  wrong. Fix exactly those mistakes; every rule below still applies.
  A window without `feedback` is a first attempt.

## What to write

- `headline`: at most 90 characters. The scene in one plain phrase, the way
  a friend would name it. If the dialogue makes the scene recognizable by its
  common name, use that name; otherwise describe what is said.
- `summary`: one or two sentences on what happens in this exchange. Ground
  every claim in the lines you were given. Do not use anything you know about
  the film that the window itself does not show.
- `evidence`: for each claim in the summary, the seq range of the lines that
  back it. Ranges must fall inside `startSeq`..`endSeq`.

Hard rules:

- No proper noun may appear in the headline or summary unless it appears in
  the window's dialogue or in the film's title. If the speakers are unnamed
  in the window, call them what the dialogue shows: the captain, the two men,
  the caller.
- No spoilers imported from outside the window. If the window contains the
  reveal, describe it plainly; if it does not, do not hint at it.
- No judgment words about quality (iconic, brilliant, famous). Describe, do
  not review.

## Output

JSON only, no commentary. An array with one entry per input window:

```json
[
  {
    "windowId": "11:120-131",
    "headline": "the scene in one phrase",
    "summary": "What happens, grounded in the lines.",
    "evidence": [{ "start": 120, "end": 124 }]
  }
]
```
