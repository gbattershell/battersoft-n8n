FROM n8nio/n8n:2.11.4

USER root

# Install build tools required to compile better-sqlite3 native module on Alpine (musl libc).
# If better-sqlite3 gains a prebuilt musl binary, the apk lines can be removed.
RUN apk add --no-cache python3 make g++

# Copy package.json to /home/node so that:
#   1. Node.js finds "type":"module" when resolving scripts under /home/node/scripts/
#   2. npm install creates /home/node/node_modules/ for our dependencies
COPY package.json package-lock.json /home/node/

# Install production dependencies. /home/node/node_modules/ is naturally on Node.js's
# module resolution path for any script under /home/node/ (e.g. /home/node/scripts/**).
RUN cd /home/node && npm ci --production

# Remove build tools to keep image size down
RUN apk del make g++

USER node
