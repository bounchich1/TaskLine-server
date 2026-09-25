FROM node:22.22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS build
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime-deps
RUN npm ci --omit=dev

FROM node:22.22-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    HOST=0.0.0.0 \
    MAX_CA_FILE=/app/certs/russian-trusted-root-ca.pem
WORKDIR /app
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY contracts ./contracts
COPY agent-skills ./agent-skills
COPY certs ./certs
USER node
EXPOSE 3000 3001
CMD ["node", "dist/main.js", "api"]
