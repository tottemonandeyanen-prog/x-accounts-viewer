# Cloud Run用：Playwright + Chromium + Node
FROM mcr.microsoft.com/playwright:v1.47.2-jammy
ENV TZ=Asia/Tokyo
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
