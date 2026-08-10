import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "./client.js";

export function slugify(input: string): string {
  return input
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "world";
}

export async function ensureProject(db: Db, name: string, language: string) {
  const slug = slugify(name);
  const result = await db.query(
    `INSERT INTO projects(slug, name, language)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, language = EXCLUDED.language, updated_at = now()
     RETURNING *`,
    [slug, name, language],
  );
  return result.rows[0];
}

export async function ingestSourceDocument(db: Db, projectId: string, filePath: string) {
  const absolute = path.resolve(filePath);
  const content = await fs.readFile(absolute, "utf8");
  const sha = crypto.createHash("sha256").update(content).digest("hex");
  const title = path.basename(absolute);
  const inserted = await db.query(
    `INSERT INTO source_documents(project_id, source_path, title, content_sha256, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (project_id, content_sha256)
     DO UPDATE SET source_path = EXCLUDED.source_path, title = EXCLUDED.title
     RETURNING *`,
    [projectId, absolute, title, sha, JSON.stringify({ bytes: Buffer.byteLength(content, "utf8") })],
  );
  return { document: inserted.rows[0], content };
}
