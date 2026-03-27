FROM oven/bun:1 AS build
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .

FROM oven/bun:1
WORKDIR /app
RUN addgroup --gid 1001 negotiator && adduser --uid 1001 --gid 1001 --disabled-password negotiator
COPY --from=build /app/src ./src
COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
USER negotiator
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s CMD bun -e "fetch('http://localhost:3002/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["bun", "run", "src/server.ts"]
