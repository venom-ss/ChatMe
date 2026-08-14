FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY --chown=node:node server.js ./server.js
COPY --chown=node:node public ./public

ENV NODE_ENV=production
ENV PORT=8000
ENV WS_NO_BUFFER_UTIL=1
ENV WS_NO_UTF_8_VALIDATE=1

EXPOSE 8000

USER node
CMD ["node", "server.js"]
