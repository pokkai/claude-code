FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data && chown app:app /data
USER app

ENV PORT=8080 \
    DATA_DIR=/data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server/index.js"]
