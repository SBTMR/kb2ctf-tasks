FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
ENV NODE_ENV=production HOME=/tmp/browser-home
RUN groupadd --gid 10001 lab && useradd --uid 10001 --gid lab --no-create-home lab
WORKDIR /app/bot
COPY bot/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY bot/ ./
RUN chmod -R a+rX /app/bot
USER 10001:10001
CMD ["node", "main.js"]
