<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  let query = $derived(data.response?.query ?? '');

  const hasResults = $derived(data.response !== null && data.response.hits.length > 0);
  const searched = $derived(data.response !== null);

  // An emptied box means start over: drop the results and return to the landing state.
  function onInput() {
    if (searched && query.trim() === '') {
      void goto(resolve('/'), { keepFocus: true });
    }
  }

  function posterUrl(path: string | null): string | null {
    return path ? `https://image.tmdb.org/t/p/w92${path}` : null;
  }

  function arcLabel(arc: number): string {
    return `${Math.round(arc * 100)}% in`;
  }
</script>

<svelte:head>
  <title>{searched ? `${data.response!.query} - Unquote` : 'Unquote'}</title>
  <meta
    name="description"
    content="Search the dialogue of 2,500 films by quote, half-memory, or scene description."
  />
</svelte:head>

<main class:searched>
  <header>
    <h1><a href={resolve('/')}>Unquote</a></h1>
    {#if !searched}
      <p class="tagline">What was that line?</p>
    {/if}
    <form role="search" method="get" action="/">
      <input
        type="search"
        name="q"
        bind:value={query}
        oninput={onInput}
        placeholder="A line you remember, or a scene you can describe"
        aria-label="Search movie dialogue"
        autocomplete="off"
      />
    </form>
  </header>

  {#if searched}
    <section class="results" aria-label="Search results">
      {#if data.response!.movie}
        {@const movie = data.response!.movie}
        <div class="movie-banner">
          {#if posterUrl(movie.posterPath)}
            <img src={posterUrl(movie.posterPath)} alt="" width="46" height="69" />
          {/if}
          <div>
            <p class="movie-name">{movie.title} <span class="year">({movie.year})</span></p>
            <p class="movie-note">That's a film. Its most memorable lines are coming soon.</p>
          </div>
        </div>
      {/if}

      {#if hasResults}
        <ol>
          {#each data.response!.hits as hit, index (hit.movieId + ':' + hit.seq)}
            {#if index === data.response!.strongCount}
              <li class="divider" aria-hidden="true"><span>weaker matches</span></li>
            {/if}
            <li class="hit" class:weak={index >= data.response!.strongCount}>
              {#if posterUrl(hit.posterPath)}
                <img
                  src={posterUrl(hit.posterPath)}
                  alt=""
                  width="46"
                  height="69"
                  loading={index < 4 ? 'eager' : 'lazy'}
                />
              {:else}
                <span class="poster-blank"></span>
              {/if}
              <div>
                <blockquote>{hit.text}</blockquote>
                <p class="meta">
                  <strong>{hit.title}</strong>
                  <span class="year">({hit.year})</span>
                  <span class="arc">{arcLabel(hit.arc)}</span>
                  {#if hit.occurrences > 1}
                    <span class="arc">said {hit.occurrences} times</span>
                  {/if}
                </p>
              </div>
            </li>
          {/each}
        </ol>
      {:else}
        <p class="empty">Nothing close enough. Try fewer words, or describe the scene instead.</p>
      {/if}
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
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  main.searched {
    justify-content: flex-start;
  }

  header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    width: min(44rem, 100%);
  }

  .searched header {
    padding-top: var(--space-3);
  }

  h1 {
    font-family: var(--font-quote);
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: 0.01em;
    margin: 0;
  }

  .searched h1 {
    font-size: var(--text-lg);
  }

  h1 a {
    color: inherit;
    text-decoration: none;
  }

  .tagline {
    color: var(--text-muted);
    font-family: var(--font-quote);
    font-style: italic;
    font-size: var(--text-lg);
    margin: 0 0 var(--space-4);
  }

  form {
    width: 100%;
  }

  input {
    width: 100%;
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-lg);
    font-family: var(--font-ui);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  input::placeholder {
    color: var(--text-muted);
  }

  .results {
    width: min(44rem, 100%);
    padding-bottom: var(--space-6);
  }

  .movie-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    margin: var(--space-3) 0;
  }

  .movie-banner img {
    border-radius: 4px;
  }

  .movie-name {
    margin: 0;
    font-weight: 600;
  }

  .movie-note {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  ol {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .hit {
    display: flex;
    gap: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
  }

  .hit.weak {
    opacity: 0.55;
  }

  .hit img,
  .poster-blank {
    flex: 0 0 46px;
    height: 69px;
    border-radius: 4px;
    background: var(--surface-raised);
  }

  blockquote {
    font-family: var(--font-quote);
    font-size: 1.1rem;
    margin: 0 0 var(--space-2);
    quotes: '\201C' '\201D';
  }

  blockquote::before {
    content: open-quote;
  }

  blockquote::after {
    content: close-quote;
  }

  .meta {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .meta strong {
    color: var(--text);
    font-weight: 600;
  }

  .arc {
    margin-left: var(--space-2);
  }

  .divider {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: var(--space-2) 0;
  }

  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--border);
  }

  .empty {
    color: var(--text-muted);
    text-align: center;
    margin-top: var(--space-5);
  }

  footer {
    margin-top: auto;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    padding: var(--space-4) var(--space-4) var(--space-2);
  }

  footer a {
    color: inherit;
  }

  @media (max-width: 480px) {
    .hit img,
    .poster-blank {
      flex-basis: 38px;
      height: 57px;
    }
  }
</style>
