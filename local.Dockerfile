# Local trial image, used by docker-compose.yml and start-local.bat. NOT for production: it runs with
# the development sign-in. The production image is the file named Dockerfile.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
# Build the browser app and the server (the same two builds as "npm run build", without the type check).
RUN npx vite build && npx vite build --config vite.server.config.ts
ENV NODE_ENV=development \
    PORT=8080 \
    STATIC_DIR=dist/client \
    MIGRATIONS_DIR=server/db/migrations \
    SEED_DIR=seed
EXPOSE 8080
# Create or update the tables, import the bundled questions, add the test users, then start.
# Each step is safe to repeat, so restarting the container keeps your data.
CMD ["sh", "-c", "node dist/server/cli.js migrate && node dist/server/cli.js seed && node dist/server/cli.js dev-users && exec node dist/server/main.js"]
