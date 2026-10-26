FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
ENV NODE_ENV=production HOME=/tmp/browser-home
WORKDIR /app/kb-search
RUN groupadd --gid 10001 lab && useradd --uid 10001 --gid lab --no-create-home lab
COPY kb-search/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY kb-search/lib.js kb-search/server.js kb-search/catalog.json ./
COPY kb-search/static/ ./static/
COPY kb-search-bot/package.json kb-search-bot/policy.js kb-search-bot/visitor.js ../kb-search-bot/
USER 10001:10001
EXPOSE 8080
CMD ["node", "server.js"]
