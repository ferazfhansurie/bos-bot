FROM node:24-bookworm-slim AS room
WORKDIR /app/services/cloud
COPY services/cloud/package*.json ./
RUN npm ci --omit=dev && ln -s /app/services/cloud/node_modules /app/node_modules
COPY services/cloud/ ./
COPY shared/cloud-protocol/ /app/shared/cloud-protocol/
RUN mkdir -p /objects && chown node:node /objects
USER node
CMD ["node", "--experimental-strip-types", "selfhost.ts", "room"]

FROM node:24-bookworm-slim AS issuer
WORKDIR /app/services/selfhost-issuer
COPY services/selfhost-issuer/package*.json ./
RUN npm ci --omit=dev
COPY services/selfhost-issuer/ ./
USER node
CMD ["node", "--experimental-strip-types", "server.ts"]
