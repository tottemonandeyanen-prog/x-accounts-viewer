import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const {
  R2_ENDPOINT,
  R2_BUCKET,
  R2_PUBLIC_HOST,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY
} = process.env;

// 起動時に必須envを全チェック
for (const [k, v] of Object.entries({
  R2_ENDPOINT, R2_BUCKET, R2_PUBLIC_HOST, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
})) {
  if (!v || String(v).trim() === "") throw new Error(`[R2 config] Missing env: ${k}`);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  forcePathStyle: true, // ★ R2はpath-style推奨（SNIまわりの握手失敗も回避）
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

export async function getObjectTextFromR2(key) {
  const resp = await s3.send(new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key
  }));
  if (!resp.Body) return null;
  const text = await resp.Body.transformToString();
  return text;
}

export async function putObjectToR2(key, body, contentType = "application/octet-stream") {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: "public, max-age=60"
  }));
}

export async function uploadToR2(Key, Body, ContentType = "image/jpeg") {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key,
    Body,
    ContentType,
    CacheControl: "public, max-age=3600, stale-while-revalidate=86400"
  }));
  const host = R2_PUBLIC_HOST.replace(/\/+$/, "");
  const key = String(Key).replace(/^\/+/, "");
  return `${host}/${key}`;
}

// prefix（例: "accounts/username/"）配下をLIST→DELETEで全削除
export async function deletePrefixFromR2(prefix) {
  const norm = String(prefix).replace(/^\/+/, "");
  let ContinuationToken;
  const objects = [];
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: norm,
      ContinuationToken
    }));
    (resp.Contents || []).forEach(o => objects.push({ Key: o.Key }));
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken);

  while (objects.length) {
    const chunk = objects.splice(0, 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: { Objects: chunk, Quiet: true }
    }));
  }
  const host = R2_PUBLIC_HOST.replace(/\/+$/, "");
  return `${host}/${norm.replace(/\/+$/, "")}`;
}