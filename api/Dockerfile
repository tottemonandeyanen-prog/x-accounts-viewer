# Playwright + 3ブラウザ入り公式ベース（Ubuntu Jammy）
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# 依存ファイルだけ先にコピーして npm ci のキャッシュを効かせる
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# アプリ本体
COPY . .

# 本番モード
ENV NODE_ENV=production

# Render が割り当てる PORT を使う（server.js は process.env.PORT を参照）
EXPOSE 8080

# ブラウザはベースイメージ内に既に同梱。追加DL不要。
CMD ["node", "server.js"]
