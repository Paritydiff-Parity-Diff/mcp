FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY tools/mcp/package.json tools/mcp/package-lock.json ./tools/mcp/
RUN npm ci --prefix tools/mcp --ignore-scripts --omit=dev && npm cache clean --force
COPY tools/mcp ./tools/mcp
USER node
ENTRYPOINT ["node","/app/tools/mcp/server.mjs"]
