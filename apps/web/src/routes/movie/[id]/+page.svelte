<script lang="ts">
  import type { ContextLevel } from '@unquote/shared';
  import { resolve } from '$app/paths';
  import type { ExpandableNeighbor, NeighborPayload } from '$lib/server/movie.js';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  const DIAL: Array<{ level: ContextLevel; label: string; full: string }> = [
    { level: 'line', label: 'Line', full: 'Exact line' },
    { level: 'beat', label: 'Exchange', full: 'Exchange' },
    { level: 'segment', label: 'Scene', full: 'Scene' },
    { level: 'movie', label: 'Movie', full: 'Whole movie' },
  ];

  const SOURCE_PREVIEW_LINES = 4;

  let selectedSeq = $state<number | null>(null);
  let levels = $state<NeighborPayload | null>(null);
  let level = $state<ContextLevel>('beat');
  let loading = $state(false);
  let expanded = $state(false);
  let expandedNeighbor = $state<string | null>(null);
  let dragY = $state(0);
  let dragging = $state(false);
  let dragFrom: number | null = null;
  let dragMoved = false;

  const shown = $derived<ExpandableNeighbor[]>(levels ? levels[level] : []);
  const selectedSegment = $derived(
    selectedSeq === null
      ? null
      : (data.segments.find((s) => s.startSeq <= selectedSeq! && selectedSeq! <= s.endSeq) ?? null),
  );

  /** The selected part's own text at the active level; none at movie width. */
  const sourceLines = $derived.by<string[]>(() => {
    const source = levels?.source;
    if (!source) return [];
    if (level === 'line') return [source.line.text];
    if (level === 'beat') return source.beat?.lines ?? [];
    if (level === 'segment') return source.segment?.lines ?? [];
    return [];
  });
  const sourceTotal = $derived(
    level === 'segment' ? (levels?.source.segment?.totalLines ?? 0) : sourceLines.length,
  );
  const sourceShown = $derived(expanded ? sourceLines : sourceLines.slice(0, SOURCE_PREVIEW_LINES));
  const sourceCapped = $derived(expanded && sourceTotal > sourceLines.length);

  async function select(seq: number) {
    selectedSeq = seq;
    loading = true;
    levels = null;
    expanded = false;
    expandedNeighbor = null;
    dragY = 0;
    try {
      const response = await fetch(`/api/movie/${data.movie.id}/neighbors?seq=${seq}`);
      if (response.ok) levels = (await response.json()) as NeighborPayload;
    } finally {
      loading = false;
    }
  }

  function close() {
    selectedSeq = null;
    levels = null;
    expanded = false;
    expandedNeighbor = null;
    dragY = 0;
  }

  function neighborKey(n: { movieId: number; startSeq: number }): string {
    return `${n.movieId}:${n.startSeq}`;
  }

  function toggleNeighbor(key: string) {
    expandedNeighbor = expandedNeighbor === key ? null : key;
  }

  // Pointer events with capture on the handle: iOS treats passive touch
  // listeners as scroll hints, so touch handlers never saw the drag. The
  // handle also carries touch-action: none, which is what actually stops the
  // sheet's internal scroll from eating the gesture.
  function onPointerDown(event: PointerEvent) {
    dragFrom = event.clientY;
    dragMoved = false;
    dragging = true;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events in tests have no active pointer to capture.
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging || dragFrom === null) return;
    dragY = Math.max(0, event.clientY - dragFrom);
    if (dragY > 5) dragMoved = true;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (dragY > 80) close();
    else dragY = 0;
    dragFrom = null;
  }

  function onHandleClick() {
    // A drag that settled should not double as a tap.
    if (!dragMoved) close();
    dragMoved = false;
  }

  $effect(() => {
    if (data.initialSeq !== null && selectedSeq === null) {
      void select(data.initialSeq);
    }
  });

  function posterUrl(path: string | null, size = 'w92'): string | null {
    return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
  }

  function pct(arc: number): string {
    return `${Math.round(arc * 100)}%`;
  }

  function excerptList(excerpt: string): string[] {
    return excerpt.split('\n').filter(Boolean);
  }
</script>

<svelte:head>
  <title>{data.movie.title} ({data.movie.year}) - Unquote</title>
  <meta
    name="description"
    content="Every line of {data.movie.title} ({data.movie
      .year}): its five defining quotes, and what the rest of cinema its moments resemble."
  />
</svelte:head>

<svelte:window onkeydown={(e) => e.key === 'Escape' && selectedSeq !== null && close()} />

<main>
  <a class="home" href={resolve('/')}>Unquote</a>

  <header>
    {#if posterUrl(data.movie.posterPath, 'w185')}
      <img src={posterUrl(data.movie.posterPath, 'w185')} alt="" width="92" height="138" />
    {/if}
    <div>
      <h1>{data.movie.title} <span class="year">({data.movie.year})</span></h1>
      <p class="counts">{data.movie.lineCount.toLocaleString('en-US')} lines of dialogue</p>
    </div>
  </header>

  {#if data.lines.length > 0}
    <section aria-label="Five lines that are this film">
      <h2>In five lines</h2>
      <ol class="five">
        {#each data.lines as line (line.seq)}
          <li>
            <button class="five-line" onclick={() => select(line.seq)}>
              <blockquote>{line.text}</blockquote>
              <span class="arc">{pct(line.arc)} through</span>
            </button>
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  {#if data.segments.length > 0}
    <section aria-label="The film as a timeline of moments">
      <h2>What does this part remind you of?</h2>
      <div class="scrubber" role="tablist" aria-label="Moments of the film">
        {#each data.segments as segment (segment.idx)}
          <button
            role="tab"
            aria-selected={selectedSegment?.idx === segment.idx}
            aria-label="Moment {pct(segment.arc)} through"
            class="block"
            class:active={selectedSegment?.idx === segment.idx}
            style:flex-grow={segment.endSeq - segment.startSeq + 1}
            title="{pct(segment.arc)} through"
            onclick={() => select(segment.startSeq)}
          ></button>
        {/each}
      </div>
      <div class="scrub-ends"><span>opening</span><span>ending</span></div>
    </section>
  {/if}

  {#if selectedSeq !== null}
    <button class="backdrop" aria-label="Close" onclick={close}></button>
    <section
      class="panel"
      class:dragging
      data-state={loading ? 'loading' : 'ready'}
      data-level={level}
      style:translate="0 {dragY}px"
      aria-label="The selected moment and similar moments in other films"
    >
      <button
        class="handle"
        aria-label="Close panel"
        onclick={onHandleClick}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <span></span>
      </button>

      <div class="dial" role="radiogroup" aria-label="How wide to match">
        {#each DIAL as option (option.level)}
          <button
            role="radio"
            aria-checked={level === option.level}
            aria-label={option.full}
            class:active={level === option.level}
            onclick={() => {
              level = option.level;
              expanded = false;
              expandedNeighbor = null;
            }}
          >
            {option.label}
          </button>
        {/each}
      </div>

      {#if loading}
        <p class="panel-note">Looking across the library...</p>
      {:else}
        {#if level !== 'movie' && sourceLines.length > 0}
          <div class="this-part">
            <p class="part-label">
              This part
              {#if levels}
                <span class="arc">{pct(levels.source.line.arc)} through</span>
              {/if}
            </p>
            <div class="sub-lines">
              {#each sourceShown as text, i (i)}
                <p class="sub-line">{text}</p>
              {/each}
            </div>
            {#if sourceLines.length > SOURCE_PREVIEW_LINES}
              <button class="expander" onclick={() => (expanded = !expanded)}>
                {expanded ? 'show less' : `show all ${sourceTotal} lines`}
              </button>
            {/if}
            {#if sourceCapped}
              <p class="capped">first {sourceLines.length} of {sourceTotal} lines</p>
            {/if}
          </div>
        {/if}

        <p class="reminds-label">Reminds the library of</p>
        {#if shown.length === 0}
          <p class="panel-note">Nothing close enough at this width.</p>
        {:else}
          <ol class="neighbors">
            {#each shown as neighbor (neighborKey(neighbor))}
              <li class="neighbor" class:open={expandedNeighbor === neighborKey(neighbor)}>
                {#if level === 'movie'}
                  <a class="neighbor-row" href="{resolve('/')}movie/{neighbor.movieId}">
                    {#if posterUrl(neighbor.posterPath)}
                      <img src={posterUrl(neighbor.posterPath)} alt="" width="46" height="69" />
                    {:else}
                      <span class="poster-blank"></span>
                    {/if}
                    <span class="neighbor-body">
                      <span class="meta">
                        <strong>{neighbor.title}</strong>
                        <span class="year">({neighbor.year})</span>
                      </span>
                    </span>
                  </a>
                {:else}
                  <button
                    class="neighbor-row"
                    aria-expanded={expandedNeighbor === neighborKey(neighbor)}
                    onclick={() => toggleNeighbor(neighborKey(neighbor))}
                  >
                    {#if posterUrl(neighbor.posterPath)}
                      <img src={posterUrl(neighbor.posterPath)} alt="" width="46" height="69" />
                    {:else}
                      <span class="poster-blank"></span>
                    {/if}
                    <span class="neighbor-body">
                      {#if neighbor.excerpt && level === 'line'}
                        <blockquote>{neighbor.excerpt}</blockquote>
                      {:else if neighbor.excerpt}
                        <span class="sub-lines">
                          {#each excerptList(neighbor.excerpt) as text, i (i)}
                            <p class="sub-line">{text}</p>
                          {/each}
                        </span>
                      {/if}
                      <span class="meta">
                        <strong>{neighbor.title}</strong>
                        <span class="year">({neighbor.year})</span>
                        <span class="arc">{pct(neighbor.arc)} through</span>
                      </span>
                    </span>
                  </button>
                  {#if expandedNeighbor === neighborKey(neighbor) && neighbor.expandedLines.length > 0}
                    <div class="neighbor-more">
                      <div class="sub-lines">
                        {#each neighbor.expandedLines as text, i (i)}
                          <p class="sub-line">{text}</p>
                        {/each}
                      </div>
                      <a
                        class="open-film"
                        href="{resolve('/')}movie/{neighbor.movieId}?seq={neighbor.startSeq}"
                      >
                        Open in {neighbor.title}
                      </a>
                    </div>
                  {/if}
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      {/if}
    </section>
  {/if}

  {#if data.similar.length > 0}
    <section aria-label="Films this one resembles">
      <h2>Similar films</h2>
      <ul class="similar">
        {#each data.similar as film (film.movieId)}
          <li>
            <a href="{resolve('/')}movie/{film.movieId}">
              {#if posterUrl(film.posterPath, 'w185')}
                <img src={posterUrl(film.posterPath, 'w185')} alt="" width="92" height="138" />
              {:else}
                <span class="poster-tall"></span>
              {/if}
              <span class="similar-title">{film.title}</span>
            </a>
            <a class="meet" href="{resolve('/')}movie/{data.movie.id}/vs/{film.movieId}">
              where they meet
            </a>
          </li>
        {/each}
      </ul>
    </section>
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
    gap: var(--space-5);
  }

  .home {
    font-family: var(--font-quote);
    font-weight: 600;
    text-decoration: none;
    color: var(--text);
  }

  header {
    display: flex;
    gap: var(--space-4);
    align-items: center;
  }

  header img {
    border-radius: var(--radius);
  }

  h1 {
    font-family: var(--font-quote);
    font-size: var(--text-xl);
    margin: 0;
  }

  .year {
    color: var(--text-muted);
    font-weight: 400;
  }

  .counts {
    color: var(--text-muted);
    margin: var(--space-1) 0 0;
  }

  h2 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 var(--space-3);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .five {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .five-line {
    width: 100%;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    color: inherit;
    cursor: pointer;
    font: inherit;
  }

  .five-line:hover {
    border-color: var(--accent);
  }

  blockquote {
    font-family: var(--font-quote);
    font-size: 1.05rem;
    margin: 0;
    quotes: '\201C' '\201D';
  }

  blockquote::before {
    content: open-quote;
  }

  blockquote::after {
    content: close-quote;
  }

  .five-line .arc,
  .meta .arc,
  .part-label .arc {
    color: var(--text-muted);
    font-size: 0.8rem;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
  }

  .scrubber {
    display: flex;
    gap: 2px;
    height: 44px;
  }

  .block {
    flex-basis: 4px;
    border: none;
    border-radius: 3px;
    background: var(--surface-raised);
    cursor: pointer;
    padding: 0;
  }

  .block:hover {
    background: var(--accent);
    opacity: 0.6;
  }

  .block.active {
    background: var(--accent);
    opacity: 1;
  }

  .scrub-ends {
    display: flex;
    justify-content: space-between;
    color: var(--text-muted);
    font-size: 0.75rem;
    margin-top: var(--space-1);
  }

  .backdrop {
    display: none;
    border: none;
    padding: 0;
  }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-3);
  }

  .handle {
    display: none;
    border: none;
    background: none;
    padding: var(--space-2) 0;
    width: 100%;
    cursor: pointer;
  }

  .handle span {
    display: block;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    margin: 0 auto;
  }

  .dial {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .dial button {
    border: 1px solid var(--border);
    background: none;
    color: var(--text-muted);
    border-radius: 999px;
    padding: var(--space-1) 0;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    min-height: 36px;
    white-space: nowrap;
  }

  .dial button.active {
    background: var(--accent);
    color: var(--accent-contrast);
    border-color: var(--accent);
  }

  .this-part {
    background: var(--surface-raised);
    border-radius: var(--radius);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
  }

  .part-label,
  .reminds-label {
    margin: 0 0 var(--space-1);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .reminds-label {
    margin-bottom: var(--space-2);
  }

  .sub-lines {
    display: block;
  }

  .sub-line {
    margin: 0 0 2px;
    font-family: var(--font-quote);
    font-size: 0.95rem;
    padding-left: 0.85em;
    text-indent: -0.85em;
  }

  .sub-line::before {
    content: '- ';
    color: var(--text-muted);
  }

  .expander {
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.8rem;
    padding: var(--space-1) 0 0;
    cursor: pointer;
  }

  .capped {
    margin: var(--space-1) 0 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .panel-note {
    color: var(--text-muted);
    margin: 0;
  }

  .neighbors {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .neighbor {
    border-radius: var(--radius);
  }

  .neighbor.open {
    background: var(--surface-raised);
  }

  /* The preview replaces the teaser: while open, the row keeps only the film
     identity and the expansion carries the text once. */
  .neighbor.open .neighbor-row .sub-lines,
  .neighbor.open .neighbor-row blockquote {
    display: none;
  }

  .neighbor-row {
    display: flex;
    width: 100%;
    gap: var(--space-3);
    text-decoration: none;
    color: inherit;
    padding: var(--space-2);
    border-radius: var(--radius);
    border: none;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .neighbor-row:hover {
    background: var(--surface-raised);
  }

  .neighbor-more {
    padding: 0 var(--space-2) var(--space-2) calc(46px + var(--space-3) + var(--space-2));
  }

  .open-film {
    display: inline-block;
    margin-top: var(--space-2);
    font-size: 0.85rem;
    color: var(--accent);
    text-decoration: none;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: var(--space-1) var(--space-3);
    min-height: 32px;
  }

  .neighbor-row img,
  .poster-blank {
    flex: 0 0 46px;
    height: 69px;
    border-radius: 4px;
    background: var(--surface-raised);
  }

  .neighbor-body {
    min-width: 0;
  }

  .neighbor blockquote {
    font-size: 0.95rem;
    margin-bottom: var(--space-1);
  }

  .neighbor-more .sub-line {
    font-size: 0.9rem;
  }

  .neighbor .sub-line {
    font-size: 0.9rem;
  }

  .meta {
    font-size: 0.85rem;
    color: var(--text-muted);
    display: block;
    margin-top: var(--space-1);
  }

  .meta strong {
    color: var(--text);
  }

  .similar {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
    gap: var(--space-3);
  }

  .similar a {
    text-decoration: none;
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .similar img,
  .poster-tall {
    width: 92px;
    height: 138px;
    border-radius: var(--radius);
    background: var(--surface-raised);
  }

  .similar-title {
    font-size: 0.85rem;
  }

  .meet {
    font-size: 0.75rem;
    color: var(--text-muted);
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
    .scrubber {
      height: 30px;
    }

    .backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgb(0 0 0 / 0.45);
      z-index: 9;
    }

    .panel {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      max-height: 60dvh;
      overflow-y: auto;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      border-bottom: none;
      box-shadow: 0 -8px 30px rgb(0 0 0 / 0.4);
      z-index: 10;
      padding-top: 0;
      transition: translate 150ms ease;
    }

    .panel.dragging {
      transition: none;
    }

    .handle {
      display: block;
      position: sticky;
      top: 0;
      background: var(--surface);
      z-index: 1;
      touch-action: none;
    }

    .neighbor-row .sub-line:nth-of-type(n + 4) {
      display: none;
    }

    .neighbor-more {
      padding-left: var(--space-3);
    }
  }
</style>
