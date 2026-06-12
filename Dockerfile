FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY config/ ./config/
COPY scripts/ ./scripts/

RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY prompts/ ./prompts/
RUN mkdir -p data/mantle-repos data/impact-checks

# Phase 2 (codegraph 集成时,包名/安装方式实测后写死)
# RUN <verified install command for codegraph, pinned version>

RUN mkdir -p data/diffs data/reports data/analysis-inputs data/archive

CMD ["bun", "run", "src/index.ts"]
