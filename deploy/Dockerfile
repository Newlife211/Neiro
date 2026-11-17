# Нейросфера — боевой сервер. Без внешних npm-зависимостей.
FROM node:22-slim
ENV NODE_ENV=production TZ=Europe/Vilnius
WORKDIR /app
COPY server/package.json ./
COPY server/src ./src
COPY server/public ./public
COPY server/data ./data
RUN useradd -r -u 10001 neuro && mkdir -p /data /workspace && chown -R neuro /data /workspace
USER neuro
ENV DATA_DIR=/data WORKSPACE_DIR=/workspace PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
