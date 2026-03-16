FROM n8nio/n8n:2.11.4

USER root

# Install build tools to compile better-sqlite3 native module.
# n8n 2.11.4 ships Node.js v24 which has no prebuilt better-sqlite3 binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json to /home/node so that:
#   1. Node.js finds "type":"module" when resolving scripts under /home/node/scripts/
#   2. npm ci creates /home/node/node_modules/ with our dependencies
COPY package.json package-lock.json /home/node/

# Install production dependencies into /home/node/node_modules/ — naturally on
# Node.js's resolution path for any script under /home/node/ (e.g. scripts/**).
RUN cd /home/node && npm ci --production

USER node
