FROM node:20-bookworm-slim

WORKDIR /manager

RUN apt-get update && \
    apt-get install -y --no-install-recommends docker.io && \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

EXPOSE 4000

CMD ["node", "index.js"]
