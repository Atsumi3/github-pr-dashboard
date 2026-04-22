FROM node:24-alpine3.22
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# Use the corepack version bundled with the Node image; pnpm version is pinned
# via package.json's "packageManager" field, so no additional installs are needed.
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY src/ ./src/
EXPOSE 3001
USER node
CMD ["node", "src/server.js"]
