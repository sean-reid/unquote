<script lang="ts">
  import { resolve } from '$app/paths';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  // Pairs arrive strongest first; the strongest ribbon starts selected.
  let selected = $state(0);

  const W = 1000;
  const H = 240;
  const PAD = 28;
  const Y_A = 44;
  const Y_B = 196;

  // Stroke weight is relative to the pairs on display: the weakest shown is
  // hairline, the strongest 8px, whatever absolute scores the gate passed.
  const minScore = $derived(data.pairs.reduce((low, p) => Math.min(low, p.score), Infinity));
  const maxScore = $derived(data.pairs.reduce((top, p) => Math.max(top, p.score), -Infinity));

  function x(arc: number): number {
    return PAD + arc * (W - PAD * 2);
  }

  /** Ribbon weight carries match strength: hairline at the threshold, 8px at the best. */
  function weight(score: number): number {
    const span = Math.max(maxScore - minScore, 0.02);
    const t = Math.min(Math.max((score - minScore) / span, 0), 1);
    return 2 + t * 6;
  }

  function ribbon(arcA: number, arcB: number): string {
    const xa = x(arcA);
    const xb = x(arcB);
    return `M ${xa} ${Y_A + 3} C ${xa} ${H / 2}, ${xb} ${H / 2}, ${xb} ${Y_B - 3}`;
  }

  function pct(arc: number): string {
    return `${Math.round(arc * 100)}%`;
  }

  function move(delta: number): void {
    const n = data.pairs.length;
    if (n > 0) selected = (selected + delta + n) % n;
  }

  /** Ribbons can crowd or cross, so a click picks the nearest curve. */
  function onFigureClick(event: MouseEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const py = ((event.clientY - box.top) / box.height) * H;
    let best = -1;
    let bestDist = 40;
    data.pairs.forEach((p, i) => {
      const xa = x(p.arcA);
      const xb = x(p.arcB);
      for (let step = 0; step <= 24; step++) {
        const t = step / 24;
        const m = 1 - t;
        // Matches the cubic in ribbon(): both control points at mid height.
        const cx = m ** 3 * xa + 3 * m * m * t * xa + 3 * m * t * t * xb + t ** 3 * xb;
        const cy =
          m ** 3 * (Y_A + 3) +
          3 * m * m * t * (H / 2) +
          3 * m * t * t * (H / 2) +
          t ** 3 * (Y_B - 3);
        const dist = Math.hypot(cx - px, cy - py);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
    });
    if (best >= 0) selected = best;
  }

  function ribbonLabel(i: number): string {
    const rank = i === 0 ? ' (strongest)' : '';
    return `match ${i + 1} of ${data.pairs.length}${rank}`;
  }

  const pair = $derived(data.pairs[selected] ?? null);
</script>

<svelte:head>
  <title>Where {data.movieA.title} meets {data.movieB.title} - Unquote</title>
  <meta
    name="description"
    content="The moments where {data.movieA.title} and {data.movieB
      .title} most resemble each other."
  />
</svelte:head>

<main>
  <a class="home" href={resolve('/')}>Unquote</a>

  <h1>
    Where <a href="{resolve('/')}movie/{data.movieA.id}">{data.movieA.title}</a> meets
    <a href="{resolve('/')}movie/{data.movieB.id}">{data.movieB.title}</a>
  </h1>
  <p class="premise">
    Moments where these films sound more alike than they usually do. Thicker means closer.
  </p>

  {#if data.pairs.length === 0}
    {#if data.soundAlikeThroughout}
      <p class="empty">These two sound alike all the way through; no single moment stands out.</p>
    {:else}
      <p class="empty">These two keep their distance. No close moments found.</p>
    {/if}
  {:else}
    <div class="figure">
      <p class="film-label a">{data.movieA.title}</p>
      <!-- The stepper buttons below are the keyboard path; the svg click is a
           pointer-only shortcut to the nearest ribbon. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
      <svg
        viewBox="0 0 {W} {H}"
        role="img"
        aria-label="{data.pairs.length} shared moments"
        onclick={onFigureClick}
      >
        <line class="track a" x1={PAD} y1={Y_A} x2={W - PAD} y2={Y_A} />
        <line class="track b" x1={PAD} y1={Y_B} x2={W - PAD} y2={Y_B} />

        {#each data.pairs as p, i (i)}
          {#if i !== selected}
            <path
              class="ribbon"
              d={ribbon(p.arcA, p.arcB)}
              style:stroke-width="{weight(p.score)}px"
            />
          {/if}
        {/each}
        {#if pair}
          <path
            class="ribbon selected"
            d={ribbon(pair.arcA, pair.arcB)}
            style:stroke-width="{weight(pair.score)}px"
          />
          <circle class="anchor" cx={x(pair.arcA)} cy={Y_A} r="5" />
          <circle class="anchor" cx={x(pair.arcB)} cy={Y_B} r="5" />
        {/if}

        {#each data.pairs as p, i (i)}
          <path class="hit" data-idx={i} d={ribbon(p.arcA, p.arcB)} />
        {/each}
      </svg>
      <div class="axis">
        <p class="film-label b">{data.movieB.title}</p>
        <span class="ends">start to end</span>
      </div>
      <div class="stepper">
        <button class="step-prev" onclick={() => move(-1)} aria-label="Previous match"
          >&lsaquo;</button
        >
        <span aria-live="polite">{ribbonLabel(selected)}</span>
        <button class="step-next" onclick={() => move(1)} aria-label="Next match">&rsaquo;</button>
      </div>
    </div>

    {#if pair}
      <div class="sides">
        <a href="{resolve('/')}movie/{data.movieA.id}?seq={pair.startSeqA}">
          <p class="side-film">{data.movieA.title} <span>{pct(pair.arcA)} through</span></p>
          <blockquote>{pair.excerptA}</blockquote>
        </a>
        <a href="{resolve('/')}movie/{data.movieB.id}?seq={pair.startSeqB}">
          <p class="side-film">{data.movieB.title} <span>{pct(pair.arcB)} through</span></p>
          <blockquote>{pair.excerptB}</blockquote>
        </a>
      </div>
    {/if}
  {/if}

  <footer>
    <p>
      Film data from <a href="https://www.themoviedb.org">TMDb</a>. This product uses the TMDb API
      but is not endorsed or certified by TMDb.
    </p>
  </footer>
</main>

<style>
  main {
    max-width: 52rem;
    margin: 0 auto;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .home {
    font-family: var(--font-quote);
    font-weight: 600;
    text-decoration: none;
    color: var(--text);
  }

  h1 {
    font-family: var(--font-quote);
    font-size: var(--text-lg);
    margin: 0;
  }

  h1 a {
    color: var(--accent);
    text-decoration: none;
  }

  .premise {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .empty {
    color: var(--text-muted);
  }

  .figure {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-3) var(--space-2);
  }

  svg {
    display: block;
    width: 100%;
    height: auto;
  }

  .film-label {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
  }

  .film-label.b {
    color: var(--text-muted);
    font-weight: 500;
  }

  .axis {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-2);
  }

  .ends {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .track {
    stroke: var(--border);
    vector-effect: non-scaling-stroke;
  }

  .track.a {
    stroke-width: 4px;
  }

  .track.b {
    stroke-width: 2px;
  }

  .ribbon {
    fill: none;
    stroke: var(--accent);
    /* Dimmed gold disappears into the light theme's paper; each theme sets
       its own resting opacity. */
    opacity: var(--ribbon-rest, 0.3);
    vector-effect: non-scaling-stroke;
  }

  :global([data-theme='light']) .ribbon {
    --ribbon-rest: 0.5;
  }

  .ribbon.selected {
    opacity: 1;
  }

  .anchor {
    fill: var(--accent);
  }

  .hit {
    fill: none;
    stroke: transparent;
    stroke-width: 24px;
    vector-effect: non-scaling-stroke;
    cursor: pointer;
    pointer-events: none;
  }

  svg {
    cursor: pointer;
  }

  .stepper {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding-top: var(--space-2);
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .stepper button {
    background: var(--surface-raised);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-width: 44px;
    min-height: 32px;
    font-size: 1rem;
    cursor: pointer;
  }

  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .sides a {
    text-decoration: none;
    color: inherit;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
  }

  .side-film {
    margin: 0 0 var(--space-2);
    font-weight: 600;
    font-size: 0.9rem;
  }

  .side-film span {
    color: var(--text-muted);
    font-weight: 400;
    font-size: 0.8rem;
  }

  blockquote {
    font-family: var(--font-quote);
    margin: 0;
    quotes: '\201C' '\201D';
  }

  blockquote::before {
    content: open-quote;
  }

  blockquote::after {
    content: close-quote;
  }

  footer {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  footer a {
    color: inherit;
  }

  @media (max-width: 768px) {
    .sides {
      grid-template-columns: 1fr;
    }
  }
</style>
