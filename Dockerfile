FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY config/ ./config/
COPY scripts/ ./scripts/
COPY prompts/ ./prompts/

RUN mkdir -p data/diffs data/reports data/analysis-inputs data/archive

CMD ["bun", "run", "src/index.ts"]
