<script lang="ts">
  import type { ContextLevel, MomentNeighbor, NeighborLevels } from '@unquote/shared';
  import { resolve } from '$app/paths';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  const DIAL: Array<{ level: ContextLevel; label: string }> = [
    { level: 'line', label: 'Exact line' },
    { level: 'beat', label: 'Exchange' },
    { level: 'segment', label: 'Scene' },
    { level: 'movie', label: 'Whole movie' },
  ];

  let selectedSeq = $state<number | null>(null);
  let levels = $state<NeighborLevels | null>(null);
  let level = $state<ContextLevel>('beat');
  let loading = $state(false);

  const shown = $derived<MomentNeighbor[]>(levels ? levels[level] : []);
  const selectedSegment = $derived(
    selectedSeq === null
      ? null
      : (data.segments.find((s) => s.startSeq <= selectedSeq! && selectedSeq! <= s.endSeq) ?? null),
  );

  async function select(seq: number) {
    selectedSeq = seq;
    loading = true;
    levels = null;
    try {
      const response = await fetch(`/api/movie/${data.movie.id}/neighbors?seq=${seq}`);
      if (response.ok) levels = (await response.json()) as NeighborLevels;
    } finally {
      loading = false;
    }
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
</script>

<svelte:head>
  <title>{data.movie.title} ({data.movie.year}) - Unquote</title>
  <meta
    name="description"
    content="Every line of {data.movie.title} ({data.movie
      .year}): its five defining quotes, and what the rest of cinema its moments resemble."
  />
</svelte:head>

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
            class="block"
            class:active={selectedSegment?.idx === segment.idx}
            style:flex-grow={segment.endSeq - segment.startSeq + 1}
            title="{pct(segment.arc)} through"
            onclick={() => select(segment.startSeq)}
          ></button>
        {/each}
      </div>
      <div class="scrub-ends"><span>opening</span><span>ending</span></div>

      <ol class="chapters">
        {#each data.segments as segment (segment.idx)}
          <li>
            <button
              class="chapter"
              class:active={selectedSegment?.idx === segment.idx}
              onclick={() => select(segment.startSeq)}
            >
              <span class="arc">{pct(segment.arc)}</span>
              <span class="snippet">{segment.snippet}</span>
            </button>
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  {#if selectedSeq !== null}
    <section
      class="panel"
      data-state={loading ? 'loading' : 'ready'}
      aria-label="Similar moments in other films"
    >
      <div class="dial" role="radiogroup" aria-label="How wide to match">
        {#each DIAL as option (option.level)}
          <button
            role="radio"
            aria-checked={level === option.level}
            class:active={level === option.level}
            onclick={() => (level = option.level)}
          >
            {option.label}
          </button>
        {/each}
      </div>

      {#if loading}
        <p class="panel-note">Looking across the library...</p>
      {:else if shown.length === 0}
        <p class="panel-note">Nothing close enough at this width.</p>
      {:else}
        <ol class="neighbors">
          {#each shown as neighbor (neighbor.movieId + ':' + neighbor.startSeq)}
            <li>
              <a
                class="neighbor"
                href="{resolve('/')}movie/{neighbor.movieId}?seq={neighbor.startSeq}"
              >
                {#if posterUrl(neighbor.posterPath)}
                  <img src={posterUrl(neighbor.posterPath)} alt="" width="46" height="69" />
                {:else}
                  <span class="poster-blank"></span>
                {/if}
                <span>
                  {#if neighbor.excerpt}
                    <blockquote>{neighbor.excerpt}</blockquote>
                  {/if}
                  <span class="meta">
                    <strong>{neighbor.title}</strong>
                    <span class="year">({neighbor.year})</span>
                    {#if level !== 'movie'}
                      <span class="arc">{pct(neighbor.arc)} through</span>
                    {/if}
                  </span>
                </span>
              </a>
            </li>
          {/each}
        </ol>
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
  .meta .arc {
    color: var(--text-muted);
    font-size: 0.8rem;
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

  .chapters {
    display: none;
    list-style: none;
    margin: 0;
    padding: 0;
    flex-direction: column;
    gap: var(--space-2);
  }

  .chapter {
    width: 100%;
    display: flex;
    gap: var(--space-3);
    align-items: baseline;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-2) var(--space-3);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .chapter.active {
    border-color: var(--accent);
  }

  .chapter .arc {
    color: var(--text-muted);
    font-size: 0.8rem;
    flex: 0 0 3rem;
  }

  .chapter .snippet {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-3);
  }

  .dial {
    display: flex;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }

  .dial button {
    border: 1px solid var(--border);
    background: none;
    color: var(--text-muted);
    border-radius: 999px;
    padding: var(--space-1) var(--space-3);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .dial button.active {
    background: var(--accent);
    color: var(--accent-contrast);
    border-color: var(--accent);
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
    display: flex;
    gap: var(--space-3);
    text-decoration: none;
    color: inherit;
    padding: var(--space-2);
    border-radius: var(--radius);
  }

  .neighbor:hover {
    background: var(--surface-raised);
  }

  .neighbor img,
  .poster-blank {
    flex: 0 0 46px;
    height: 69px;
    border-radius: 4px;
    background: var(--surface-raised);
  }

  .neighbor blockquote {
    font-size: 0.95rem;
    margin-bottom: var(--space-1);
  }

  .meta {
    font-size: 0.85rem;
    color: var(--text-muted);
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
    .scrubber,
    .scrub-ends {
      display: none;
    }

    .chapters {
      display: flex;
      max-height: 40dvh;
      overflow-y: auto;
    }

    .panel {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      max-height: 60dvh;
      overflow-y: auto;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      box-shadow: 0 -8px 30px rgb(0 0 0 / 0.4);
      z-index: 10;
    }
  }
</style>
