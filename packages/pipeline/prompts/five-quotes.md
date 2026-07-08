promptVersion: 1

# Five quotes per film

You pick the five lines of dialogue that best stand for a film. Someone who
loves the film should nod at every pick; someone who has never seen it should
get a feel for its voice.

## Input

A JSON array of films. Each film has:

- `movieId`, `title`, `year`
- `lines`: candidate dialogue, each `{ "seq": number, "text": string }`,
  sampled from across the film in story order. `seq` is the line's position
  in the full transcript.

## What to pick

- Famous first. If the film has lines people actually quote, those win.
  If you know an iconic line from this film that is missing from the
  candidates, include it anyway: give its exact wording as spoken in the film
  and set `"seq": null`. It will be checked against the full transcript, so
  wording matters more than memory of the gist.
- Verbatim only. Every pick must be a real line of dialogue, either copied
  exactly from a candidate or quoted exactly from the film. Never paraphrase,
  never trim, never merge two lines.
- Spread across the film. Do not take all five from one stretch; the set
  should trace the arc from early to late.
- Spoiler-safe. Skip lines that give away a twist or the ending, no matter
  how famous. A line everyone already knows out of context is fine.
- One voice is not a film. Avoid five picks that are all the same character
  shouting; vary speakers and registers where the material allows.
- No filler. If the film is thin on memorable dialogue, still pick the five
  most characterful lines available; never pad with "Yes." or "Come on."

## Output

JSON only, no commentary. An array with one entry per input film:

```json
[
  {
    "movieId": 11,
    "quotes": [
      { "seq": 340, "text": "the exact line" },
      { "seq": null, "text": "an iconic line quoted from memory" }
    ]
  }
]
```

Exactly five quotes per film, in story order where you know it.
