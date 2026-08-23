FROM node:22-bookworm

RUN npm install --global pnpm@11.19.0 \
    && apt-get update \
    && apt-get install --yes --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
ENTRYPOINT ["sh", "-lc"]
