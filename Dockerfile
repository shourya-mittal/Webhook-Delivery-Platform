FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

EXPOSE 3000
# Runs migrations, then the API and the worker in one process (src/index.ts).
# Node runs directly, not via npx, so it receives SIGTERM from `docker stop` and
# can shut down cleanly (finish in-flight deliveries, then exit 0).
CMD ["node", "--import", "tsx", "src/index.ts"]
