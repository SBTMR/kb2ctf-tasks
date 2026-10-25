FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production
RUN groupadd --gid 10001 lab && useradd --uid 10001 --gid lab --no-create-home lab
WORKDIR /app/app
COPY app/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app/ ./
RUN chmod -R a+rX /app/app && mkdir -p /var/lib/lab/xss && chown 10001:10001 /var/lib/lab/xss
USER 10001:10001
EXPOSE 8080
CMD ["node", "server.js"]
