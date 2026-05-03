FROM node:20-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy source
COPY . .

# Railway sets PORT env var; default to 8080 if absent
ENV PORT=8080
ENV MCP_HTTP=true

EXPOSE 8080

# Healthcheck against the root endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["node", "index.js"]
