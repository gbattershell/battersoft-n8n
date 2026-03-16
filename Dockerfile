# Stage 1: compile native dependencies using a full Node.js image with build tools.
# Must match the Node.js major version that n8n 2.11.4 ships (v24) so the
# native module ABI version is identical in both stages.
FROM node:24-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --production

# Stage 2: add compiled deps to the n8n image — no package manager needed.
FROM n8nio/n8n:2.11.4
USER root

# /home/node/node_modules/ is on Node.js's resolution path for scripts under
# /home/node/ (which includes the mounted /home/node/scripts volume).
COPY --from=deps /build/node_modules /home/node/node_modules

# package.json at /home/node/ tells Node.js that .js files here are ES modules.
COPY package.json /home/node/

USER node
