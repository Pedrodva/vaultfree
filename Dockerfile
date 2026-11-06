# cloudflared (official image) provides the optional "Share online" tunnel
FROM cloudflare/cloudflared:2026.10.7 AS tunnel

FROM node:22-alpine
WORKDIR /app
COPY --from=tunnel /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY package.json ./
COPY bin ./bin
COPY server ./server
COPY shared ./shared
COPY web ./web
ENV VAULTFREE_DATA=/data VAULTFREE_HOST=0.0.0.0 VAULTFREE_PORT=3000 NODE_ENV=production
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "bin/vaultfree.js", "serve"]
