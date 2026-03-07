# zkTrident Leviathan Sequencer
#
# Runs the L2 sequencer node with RPC server, SSE events,
# checkpoint recovery, and optional ProvingPool workers.
#
# Build:  docker build -t zktrident-leviathan .
# Run:    docker run -p 3030:3030 -v leviathan-data:/data zktrident-leviathan

FROM node:20-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm install --ignore-scripts

# Copy source + config
COPY tsconfig.json ./
COPY src/ ./src/

# Data directory for checkpoints + WAL (mount as persistent volume)
RUN mkdir -p /data

# Run as non-root user for security
RUN groupadd -r zktrident && useradd -r -g zktrident zktrident \
    && chown -R zktrident:zktrident /app /data
USER zktrident

EXPOSE 3030

# Defaults — override via env vars or render.yaml
ENV ZKTRIDENT_PORT=3030
ENV ZKTRIDENT_HOST=0.0.0.0
ENV ZKTRIDENT_CHECKPOINT_DIR=/data/l2-data
ENV ZKTRIDENT_L2_ONLY=true

CMD ["npx", "tsx", "src/nodes/start-leviathan.ts"]
