FROM n8nio/n8n:2.11.4

USER root

# Copy package.json to /home/node so that:
#   1. Node.js finds "type":"module" when resolving scripts under /home/node/scripts/
#   2. npm ci creates /home/node/node_modules/ with our dependencies
# The n8n image is Debian-based (glibc), so better-sqlite3 prebuilt binaries
# install without needing build tools.
COPY package.json package-lock.json /home/node/

# Install production dependencies into /home/node/node_modules/ — naturally on
# Node.js's resolution path for any script under /home/node/ (e.g. scripts/**).
RUN cd /home/node && npm ci --production

USER node
