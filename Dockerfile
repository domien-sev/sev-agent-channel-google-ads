FROM node:22-alpine AS builder

ARG GH_PKG_TOKEN
ENV GH_PKG_TOKEN=$GH_PKG_TOKEN

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

ARG GH_PKG_TOKEN
ENV GH_PKG_TOKEN=$GH_PKG_TOKEN

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm install --omit=dev
# Remove .npmrc and token from final image
RUN rm -f .npmrc
COPY --from=builder /app/dist ./dist
ENV GH_PKG_TOKEN=""

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
