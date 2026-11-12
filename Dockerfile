FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
ENV PORT=3000 DB_PATH=/app/data/db.json NODE_ENV=production
RUN mkdir -p /app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
