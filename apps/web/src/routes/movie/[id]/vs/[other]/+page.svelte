<script lang="ts">
  import { resolve } from '$app/paths';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  function pct(arc: number): string {
    return `${Math.round(arc * 100)}%`;
  }
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

  {#if data.pairs.length === 0}
    <p class="empty">These two keep their distance. No close moments found.</p>
  {:else}
    <ol class="pairs">
      {#each data.pairs as pair, i (i)}
        <li class="pair">
          <div class="timelines">
            <div class="track" title="{data.movieA.title}: {pct(pair.arcA)} through">
              <span class="dot" style:left={pct(pair.arcA)}></span>
            </div>
            <div class="track" title="{data.movieB.title}: {pct(pair.arcB)} through">
              <span class="dot" style:left={pct(pair.arcB)}></span>
            </div>
          </div>
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
        </li>
      {/each}
    </ol>
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
    gap: var(--space-4);
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

  .empty {
    color: var(--text-muted);
  }

  .pairs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .pair {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-3);
  }

  .timelines {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .track {
    position: relative;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-raised);
  }

  .dot {
    position: absolute;
    top: -3px;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    border-radius: 50%;
    background: var(--accent);
  }

  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .sides a {
    text-decoration: none;
    color: inherit;
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

  @media (max-width: 600px) {
    .sides {
      grid-template-columns: 1fr;
    }
  }
</style>
