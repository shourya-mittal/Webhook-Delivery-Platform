FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000
# Runs migrations, then the API and the worker in one process (src/index.ts).
CMD ["npx", "tsx", "src/index.ts"]
