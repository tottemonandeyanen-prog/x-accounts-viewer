import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

const R2_ENDPOINT = process.env.R2_ENDPOINT!;
const R2_BUCKET = process.env.R2_BUCKET!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_PUBLIC_HOST = process.env.R2_PUBLIC_HOST || ""; // 例: https://cdn.example.com

if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  throw new Error(
    "R2 env missing. Set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
  );
}

export const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export function r2Url(key: string): string {
  const safe = encodeURI(key.replace(/^\/+/, ""));
  if (R2_PUBLIC_HOST) return `${R2_PUBLIC_HOST.replace(/\/+$/, "")}/${safe}`;
  return `https://${R2_BUCKET}.r2.cloudflarestorage.com/${safe}`;
}

export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return { key, url: r2Url(key) };
}

// 互換性維持：以前の呼び名をそのまま残す
export const putObjectToR2 = uploadToR2;

export async function getObjectTextFromR2(key: string): Promise<string | null> {
  try {
    const out = await s3.send(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key })
    );
    const body = out.Body as Readable;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      body.on("data", (c) => chunks.push(Buffer.from(c)));
      body.on("end", () => resolve());
      body.on("error", reject);
    });
    return Buffer.concat(chunks).toString("utf-8");
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function deletePrefixFromR2(prefix: string): Promise<number> {
  let totalDeleted = 0;
  let ContinuationToken: string | undefined = undefined;

  do {
    const listed: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken,
        MaxKeys: 1000,
      })
    );

    const objects =
      (listed.Contents ?? [])
        .filter((o) => !!o.Key)
        .map((o) => ({ Key: o.Key! })) ?? [];

    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: objects, Quiet: true },
        })
      );
      totalDeleted += objects.length;
    }

    ContinuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (ContinuationToken);

  return totalDeleted;
}
