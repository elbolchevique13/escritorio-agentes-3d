FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4747 \
    HOST=0.0.0.0 \
    OC_PORT=4096 \
    OPEN_BROWSER=0 \
    ESCRITORIO_JANELA=0

COPY package.json ./
COPY server.js remoto.js janela.js index.html claude-hook.js instalar-claude.js ./
COPY css ./css
COPY js ./js
COPY vendor ./vendor

RUN mkdir -p /app/dados && chown -R node:node /app
USER node

EXPOSE 4747

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]