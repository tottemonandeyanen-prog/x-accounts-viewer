import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT!, // e.g. https://<accountid>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!
  }
});

export async function uploadToR2(
  Key: string,
  Body: Buffer | Uint8Array,
  ContentType = "image/jpeg"
) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key,
    Body,
    ContentType,
    CacheControl: "public, max-age=3600, stale-while-revalidate=86400"
  }));
  // 公開ホスト名は R2 のカスタムドメイン or 公開バケットURL を設定
  const publicHost = process.env.R2_PUBLIC_HOST!; // e.g. https://img.example.com
  return `${publicHost}/${Key}`;
}
