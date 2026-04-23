FROM oven/bun:1.2.15

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["bun", "run", "./src/index.ts"]
