<script lang="ts">
  import { resolve } from '$app/paths';
  import type { ExpandableNeighbor, ScenePanel } from '$lib/server/movie.js';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  const SOURCE_PREVIEW_LINES = 4;

  let selectedSeq = $state<number | null>(null);
  let panel = $state<ScenePanel | null>(null);
  let loading = $state(false);
  let expanded = $state(false);
  let expandedNeighbor = $state<string | null>(null);
  let dragY = $state(0);
  let dragging = $state(false);
  let dragFrom: number | null = null;
  let dragMoved = false;
  /** Mobile sheet: expanded shows the panel, docked leaves the handle peeking. */
  let sheet = $state<'expanded' | 'docked'>('expanded');

  const moments = $derived<ExpandableNeighbor[]>(panel ? panel.moments : []);
  // Windows overlap, so identity beats containment: an explicit idx wins, and
  // deep links fall back to the container whose midpoint is nearest.
  const selectedSegment = $derived.by(() => {
    if (selectedIdx !== null) return data.segments.find((s) => s.idx === selectedIdx) ?? null;
    if (selectedSeq === null) return null;
    const containers = data.segments.filter(
      (s) => s.startSeq <= selectedSeq! && selectedSeq! <= s.endSeq,
    );
    containers.sort(
      (a, b) =>
        Math.abs(a.startSeq + a.endSeq - 2 * selectedSeq!) -
        Math.abs(b.startSeq + b.endSeq - 2 * selectedSeq!),
    );
    return containers[0] ?? null;
  });

  /** The scene's dialogue: shown compact without a summary, behind the
   * expander when the summary carries the panel. */
  const evidenceLines = $derived<string[]>(panel?.evidence.lines ?? []);
  const evidenceTotal = $derived(panel?.evidence.totalLines ?? 0);
  const evidenceShown = $derived.by<string[]>(() => {
    if (panel?.summary) return expanded ? evidenceLines : [];
    return expanded ? evidenceLines : evidenceLines.slice(0, SOURCE_PREVIEW_LINES);
  });
  const evidenceCapped = $derived(expanded && evidenceTotal > evidenceLines.length);

  let selectedIdx = $state<number | null>(null);

  async function select(seq: number, idx: number | null = null) {
    selectedSeq = seq;
    selectedIdx = idx;
    sheet = 'expanded';
    loading = true;
    panel = null;
    expanded = false;
    expandedNeighbor = null;
    dragY = 0;
    try {
      const suffix = idx === null ? '' : `&segment=${idx}`;
      const response = await fetch(`/api/movie/${data.movie.id}/neighbors?seq=${seq}${suffix}`);
      if (response.ok) panel = (await response.json()) as ScenePanel;
    } finally {
      loading = false;
    }
  }

  function dock() {
    sheet = 'docked';
    dragY = 0;
  }

  function expand() {
    sheet = 'expanded';
    dragY = 0;
  }

  function toggleSheet() {
    if (sheet === 'docked') expand();
    else dock();
  }

  let provisionalIdx = $state<number | null>(null);
  let scrubbing = false;
  let scrubFromX: number | null = null;
  let scrubMoved = false;

  function segmentAtX(strip: HTMLElement, clientX: number) {
    // Resolve against rendered geometry, not weight fractions: flex basis and
    // the 2px gaps shift pixel boundaries off the weight-space ones, which
    // made near-edge presses land one part back. Gaps go to the nearer block.
    let best = data.segments[data.segments.length - 1]!;
    let bestDistance = Number.POSITIVE_INFINITY;
    const blocks = strip.querySelectorAll<HTMLElement>('.block');
    for (const block of blocks) {
      const box = block.getBoundingClientRect();
      const distance =
        clientX < box.left ? box.left - clientX : clientX > box.right ? clientX - box.right : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        const idx = Number(block.dataset.idx);
        best = data.segments.find((s) => s.idx === idx) ?? best;
        if (distance === 0) break;
      }
    }
    return best;
  }

  function onScrubDown(event: PointerEvent) {
    scrubbing = true;
    scrubFromX = event.clientX;
    scrubMoved = false;
    provisionalIdx = segmentAtX(event.currentTarget as HTMLElement, event.clientX).idx;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events in tests have no active pointer to capture.
    }
  }

  function onScrubMove(event: PointerEvent) {
    if (!scrubbing) return;
    if (scrubFromX !== null && Math.abs(event.clientX - scrubFromX) > 5) scrubMoved = true;
    provisionalIdx = segmentAtX(event.currentTarget as HTMLElement, event.clientX).idx;
  }

  // Selection order matters: a tap must select on its trailing CLICK, after
  // the gesture has no more events to deliver. Selecting on pointerup mounted
  // the panel between pointerup and the synthesized click, which then landed
  // on the new backdrop and closed the sheet in the same breath.
  function onScrubUp(event: PointerEvent) {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Synthetic test events carry no active pointer.
    }
    provisionalIdx = null;
    if (scrubMoved) {
      // A drag ends here; its click (if any) is suppressed by scrubMoved.
      const segment = segmentAtX(event.currentTarget as HTMLElement, event.clientX);
      void select(segment.startSeq, segment.idx);
    }
  }

  // Tap environments disagree on event models (real iOS sends pointer events
  // and detail-1 clicks; test WebKit sends touch plus detail-0 clicks; desktop
  // sends both). Clicks are the one universal: blocks own clicks that hit
  // them, the strip resolves clicks landing in gaps, and pointer events only
  // add drag-to-scrub where they exist.
  function onScrubClick(event: MouseEvent) {
    // A drag already selected on release; its trailing click must not reselect.
    if (scrubMoved) {
      scrubMoved = false;
      return;
    }
    if (event.target !== event.currentTarget) return; // a block owns this click
    const segment = segmentAtX(event.currentTarget as HTMLElement, event.clientX);
    void select(segment.startSeq, segment.idx);
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
    const delta = event.clientY - dragFrom;
    // Expanded sheets drag down toward the dock; docked sheets drag up.
    dragY = sheet === 'expanded' ? Math.max(0, delta) : Math.min(0, delta);
    if (Math.abs(dragY) > 5) dragMoved = true;
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    dragFrom = null;
    // Release capture and let the gesture finish on a live element before the
    // sheet unmounts: WebKit wedges future pointer sequences when a captured
    // element is removed mid-gesture, which made the sheet unopenable after a
    // close on a real phone.
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Synthetic test events carry no active pointer.
    }
    // iOS skips click synthesis for captured pointers, so the tap must be
    // recognized here: a press that never really moved toggles the state.
    if (!dragMoved) {
      setTimeout(toggleSheet, 0);
    } else if (sheet === 'expanded' && dragY > 60) {
      setTimeout(dock, 0);
    } else if (sheet === 'docked' && dragY < -40) {
      setTimeout(expand, 0);
    } else {
      dragY = 0;
    }
  }

  function onHandleClick(event: MouseEvent) {
    // Pointer taps are handled in onPointerUp; this path serves the keyboard,
    // whose synthetic clicks carry detail 0.
    if (event.detail === 0) toggleSheet();
  }

  // SvelteKit reuses this component across client-side navigations between
  // films, so selection state must reset whenever the film (or deep-linked
  // seq) changes; otherwise the panel keeps showing the previous film's part.
  let navKey = '';
  $effect(() => {
    const next = `${data.movie.id}:${data.initialSeq}`;
    if (navKey === next) return;
    navKey = next;
    selectedSeq = null;
    selectedIdx = null;
    panel = null;
    expanded = false;
    expandedNeighbor = null;
    dragY = 0;
    if (data.initialSeq !== null) void select(data.initialSeq);
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
      .year}): its five defining quotes, and what each of its scenes reminds the library of."
  />
</svelte:head>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && selectedSeq !== null && sheet === 'expanded' && dock()}
/>

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
      <div
        class="scrubber"
        role="tablist"
        tabindex={-1}
        aria-label="Moments of the film"
        onpointerdown={onScrubDown}
        onpointermove={onScrubMove}
        onpointerup={onScrubUp}
        onclick={onScrubClick}
        onpointercancel={() => {
          scrubbing = false;
          provisionalIdx = null;
        }}
      >
        {#each data.segments as segment (segment.idx)}
          <button
            role="tab"
            aria-selected={selectedSegment?.idx === segment.idx}
            aria-label="Moment {pct(segment.arc)} through"
            data-idx={segment.idx}
            data-start={segment.startSeq}
            class="block"
            class:active={provisionalIdx === null
              ? selectedSegment?.idx === segment.idx
              : provisionalIdx === segment.idx}
            style:flex-grow={segment.endSeq - segment.startSeq + 1}
            title="{pct(segment.arc)} through"
            onclick={() => {
              // Any activation of the block itself selects it: finger, mouse,
              // or keyboard. Drags are suppressed by the strip's click guard.
              if (!scrubMoved) void select(segment.startSeq, segment.idx);
            }}
          ></button>
        {/each}
      </div>
      <div class="scrub-ends"><span>opening</span><span>ending</span></div>
    </section>
  {/if}

  {#if selectedSeq !== null}
    {#if sheet === 'expanded'}
      <button class="backdrop" aria-label="Collapse panel" onclick={dock}></button>
    {/if}
    <section
      class="panel"
      class:dragging
      data-state={loading ? 'loading' : 'ready'}
      data-sheet={sheet}
      style:--drag-y="{dragY}px"
      aria-label="The selected scene and similar moments in other films"
    >
      <button
        class="handle"
        aria-label={sheet === 'docked' ? 'Expand panel' : 'Collapse panel'}
        aria-expanded={sheet === 'expanded'}
        onclick={onHandleClick}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <span></span>
      </button>

      {#if loading}
        <p class="panel-note">Looking across the library...</p>
      {:else}
        {#if evidenceLines.length > 0}
          <div class="this-part">
            <p class="part-label">
              This scene
              {#if selectedSegment}
                <span class="arc">{pct(selectedSegment.arc)} through</span>
              {/if}
            </p>
            {#if panel?.summary}
              <h3 class="headline">{panel.summary.headline}</h3>
              <p class="summary">{panel.summary.summary}</p>
            {/if}
            <div class="sub-lines">
              {#each evidenceShown as text, i (i)}
                <p class="sub-line">{text}</p>
              {/each}
            </div>
            {#if panel?.summary || evidenceLines.length > SOURCE_PREVIEW_LINES}
              <button class="expander" onclick={() => (expanded = !expanded)}>
                {#if panel?.summary}
                  {expanded ? 'hide the dialogue' : 'read the dialogue'}
                {:else}
                  {expanded ? 'show less' : `show all ${evidenceTotal} lines`}
                {/if}
              </button>
            {/if}
            {#if evidenceCapped}
              <p class="capped">first {evidenceLines.length} of {evidenceTotal} lines</p>
            {/if}
          </div>
        {/if}

        <p class="reminds-label">Reminds the library of</p>
        {#if moments.length === 0}
          <p class="panel-note">Nothing close enough.</p>
        {:else}
          <ol class="neighbors">
            {#each moments as neighbor (neighborKey(neighbor))}
              <li class="neighbor" class:open={expandedNeighbor === neighborKey(neighbor)}>
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
                    {#if neighbor.excerpt}
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
    /* The strip owns horizontal presses; vertical swipes still scroll. */
    touch-action: pan-y;
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

  .headline {
    font-family: var(--font-quote);
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0 0 var(--space-1);
  }

  .summary {
    margin: 0 0 var(--space-1);
    color: var(--text-muted);
    font-size: 0.95rem;
    line-height: 1.5;
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
  .neighbor.open .neighbor-row .sub-lines {
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
      height: 60dvh;
      overflow-y: auto;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      border-bottom: none;
      box-shadow: 0 -8px 30px rgb(0 0 0 / 0.4);
      z-index: 10;
      padding-top: 0;
      --dock-base: 0px;
      translate: 0 calc(var(--dock-base) + var(--drag-y, 0px));
      transition: translate 150ms ease;
    }

    /* Docked: the handle strip peeks with room above the home indicator, so
       a thumb can find it without fishing at the screen's very edge. */
    .panel[data-sheet='docked'] {
      --dock-base: calc(100% - 76px - env(safe-area-inset-bottom, 0px));
      overflow-y: hidden;
    }

    .panel.dragging {
      transition: none;
    }

    .handle {
      position: sticky;
      top: 0;
      background: var(--surface);
      z-index: 1;
      touch-action: none;
      /* A finger needs something to snag: a full 44px strip, bar centered. */
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .neighbor-row .sub-line:nth-of-type(n + 4) {
      display: none;
    }

    .neighbor-more {
      padding-left: var(--space-3);
    }
  }
</style>
