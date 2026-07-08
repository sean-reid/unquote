# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/pipeline/package.json packages/pipeline/
RUN pnpm install --frozen-lockfile --filter @unquote/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @unquote/web build
# Standalone production tree: build output plus prod node_modules only.
RUN pnpm --filter @unquote/web --prod deploy --legacy /deploy

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HF_HOME=/app/.cache/hf \
    PORT=3000
WORKDIR /app
COPY --from=build /deploy .
# Bake both query encoders' weights into the image so boot never downloads.
# Names mirror EMBED_MODEL (shared/embedding.ts) and WIDE_EMBED_MODEL (web/embed.ts).
RUN node --input-type=module -e "\
  const { pipeline } = await import('@huggingface/transformers'); \
  await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'q8' }); \
  await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { dtype: 'q8' });"
RUN useradd -r app && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "build/index.js"]
