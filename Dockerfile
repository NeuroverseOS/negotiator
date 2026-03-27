FROM oven/bun:1 AS build
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .

FROM oven/bun:1
WORKDIR /app
COPY --from=build /app/src ./src
COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
EXPOSE 3002
CMD ["bun", "run", "src/server.ts"]
