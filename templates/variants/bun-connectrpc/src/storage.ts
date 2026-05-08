import { Storage } from "@google-cloud/storage";
import type { AttachmentObjectMetadata, AttachmentUploadTarget } from "./chat/types";

export type AttachmentStorage = {
  createSignedUpload(input: {
    attachmentId: string;
    conversationId: string;
    filename: string;
    contentType: string;
  }): Promise<{ bucket: string; key: string; upload: AttachmentUploadTarget; publicUrl: string }>;
  getObjectMetadata(input: { bucket: string; key: string }): Promise<AttachmentObjectMetadata>;
};

export class GcsAttachmentStorage implements AttachmentStorage {
  constructor(
    private readonly bucketName = requireAttachmentBucket(),
    private readonly publicBaseUrl = Bun.env.ATTACHMENT_PUBLIC_BASE_URL?.trim() || `https://storage.googleapis.com/${requireAttachmentBucket()}`
  ) {}

  async createSignedUpload(input: { attachmentId: string; conversationId: string; filename: string; contentType: string }) {
    const storage = new Storage();
    const bucket = storage.bucket(this.bucketName);
    const key = `attachments/${input.conversationId}/${input.attachmentId}/${sanitizeFilename(input.filename)}`;
    const file = bucket.file(key);
    const [url] = await file.getSignedUrl({
      action: "write",
      version: "v4",
      expires: Date.now() + 15 * 60 * 1000,
      contentType: input.contentType,
    });
    return {
      bucket: this.bucketName,
      key,
      upload: {
        method: "PUT" as const,
        url,
        headers: {
          "Content-Type": input.contentType,
        },
      },
      publicUrl: `${this.publicBaseUrl.replace(/\/+$/g, "")}/${key}`,
    };
  }

  async getObjectMetadata(input: { bucket: string; key: string }): Promise<AttachmentObjectMetadata> {
    const storage = new Storage();
    const [metadata] = await storage.bucket(input.bucket).file(input.key).getMetadata();
    return {
      bucket: input.bucket,
      key: input.key,
      contentType: String(metadata.contentType ?? ""),
      byteSize: Number(metadata.size ?? 0),
      publicUrl: `${this.publicBaseUrl.replace(/\/+$/g, "")}/${input.key}`,
    };
  }
}

export function createAttachmentStorage() {
  return new GcsAttachmentStorage();
}

export function requireAttachmentBucket() {
  const bucket = Bun.env.ATTACHMENT_BUCKET?.trim();
  if (!bucket) {
    throw new Error("ATTACHMENT_BUCKET is required");
  }
  return bucket;
}

function sanitizeFilename(filename: string) {
  return filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "upload.bin";
}
