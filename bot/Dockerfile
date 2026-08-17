FROM node:20-bookworm

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium
COPY server.mjs ./

ENV PORT=8080
CMD ["npm", "start"]
