FROM node:24.14.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
ENV NODE_ENV=production AGENTMEMORY_DATA_DIR=/data III_ENGINE_URL=ws://memory-engine:49134
USER 65532:65532
CMD ["node", "node_modules/@agentmemory/agentmemory/dist/index.mjs"]
