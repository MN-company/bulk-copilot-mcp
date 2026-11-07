# Runtime needs no browser: Bulk is plain GraphQL. Login (npm run login) runs on the host
# and the session file is shared through the mounted data directory.
FROM node:22-slim
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN mkdir -p /data /state && chown -R node:node /data /state /app
USER node
ENV BULK_DATA_DIR=/data BULK_DB_PATH=/state/agent.sqlite BIND_HOST=0.0.0.0 PORT=3789
EXPOSE 3789
CMD ["node", "src/server.mjs"]
