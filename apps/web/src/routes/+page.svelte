<script lang="ts">
  let query = $state('');
</script>

<svelte:head>
  <title>Unquote</title>
  <meta
    name="description"
    content="Search the dialogue of 2,500 films by quote, half-memory, or scene description."
  />
</svelte:head>

<main>
  <h1>Unquote</h1>
  <p class="tagline">What was that line?</p>
  <form role="search" onsubmit={(e) => e.preventDefault()}>
    <input
      type="search"
      name="q"
      bind:value={query}
      placeholder="A line you remember, or a scene you can describe"
      aria-label="Search movie dialogue"
      autocomplete="off"
    />
  </form>
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

  h1 {
    font-family: var(--font-quote);
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: 0.01em;
    margin: 0;
  }

  .tagline {
    color: var(--text-muted);
    font-family: var(--font-quote);
    font-style: italic;
    font-size: var(--text-lg);
    margin: 0 0 var(--space-4);
  }

  form {
    width: min(40rem, 100%);
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

  footer {
    position: fixed;
    bottom: var(--space-3);
    left: 0;
    right: 0;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    padding: 0 var(--space-4);
  }

  footer a {
    color: inherit;
  }
</style>
