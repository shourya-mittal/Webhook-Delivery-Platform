FROM node:22-slim
WORKDIR /app

# Runtime dependencies only: test and build tools don't belong in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Don't run as root: a compromised process shouldn't own the container.
USER node

EXPOSE 3000
# Runs migrations, then the API and the worker in one process (src/index.ts).
# Node runs directly, not via npx, so it receives SIGTERM from `docker stop` and
# can shut down cleanly (finish in-flight deliveries, then exit 0).
CMD ["node", "--import", "tsx", "src/index.ts"]
