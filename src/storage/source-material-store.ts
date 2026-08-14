import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nwhRuntimeDir } from "../agent/runtime-paths.js";
import type { SourceDocument } from "./workspace-store.js";

export type SourceMaterialIdentity = {
  contentMd5: string;
  contentSha256: string;
  bytes: number;
};

type SourceMaterialManifest = SourceMaterialIdentity & {
  version: 1;
  title: string;
  importedAt: string;
};

export class SourceMaterialStore {
  readonly root: string;

  constructor(runtimeDir = nwhRuntimeDir()) {
    this.root = path.join(path.resolve(runtimeDir), "sources", "v1");
  }

  async put(content: Uint8Array, title: string): Promise<SourceMaterialIdentity> {
    const buffer = Buffer.from(content);
    if (!buffer.byteLength) throw new Error(`Source content is empty: ${title}`);
    assertUtf8Text(buffer, title);
    const identity = sourceMaterialIdentity(buffer);
    const directory = this.directory(identity.contentSha256);
    const existing = await this.readBySha(identity.contentSha256);
    if (existing) {
      assertIdentity(existing, identity);
      return identity;
    }

    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const staging = `${directory}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(staging, { mode: 0o700 });
    const manifest: SourceMaterialManifest = {
      version: 1,
      title,
      ...identity,
      importedAt: new Date().toISOString(),
    };
    try {
      await fs.writeFile(path.join(staging, "source.utf8"), buffer, { mode: 0o400, flag: "wx" });
      await fs.writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
      await fs.chmod(staging, 0o500);
      try {
        await fs.rename(staging, directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        await fs.chmod(staging, 0o700);
        await fs.rm(staging, { recursive: true, force: true });
        const raced = await this.readBySha(identity.contentSha256);
        if (!raced) throw new Error(`Source material publication race lost data for ${identity.contentSha256}.`);
        assertIdentity(raced, identity);
      }
    } catch (error) {
      try {
        await fs.chmod(staging, 0o700);
        await fs.rm(staging, { recursive: true, force: true });
      } catch {
        // Preserve the publication failure.
      }
      throw error;
    }
    return identity;
  }

  async read(source: Pick<SourceDocument, "contentSha256" | "contentMd5" | "bytes">): Promise<Buffer | null> {
    const material = await this.readBySha(source.contentSha256);
    if (!material) return null;
    assertIdentity(material, {
      contentSha256: source.contentSha256,
      contentMd5: source.contentMd5 ?? material.identity.contentMd5,
      bytes: source.bytes,
    });
    return material.content;
  }

  async readBySourceId(sourceId: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{20}$/.test(sourceId)) throw new Error(`Invalid source id: ${sourceId}`);
    let matches: string[];
    try {
      matches = (await fs.readdir(this.root)).filter((name) => name.startsWith(sourceId) && /^[a-f0-9]{64}$/.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (matches.length > 1) throw new Error(`Ambiguous source id prefix: ${sourceId}`);
    if (!matches.length) return null;
    return (await this.readBySha(matches[0]!))?.content ?? null;
  }

  private async readBySha(contentSha256: string): Promise<{ identity: SourceMaterialIdentity; content: Buffer } | null> {
    if (!/^[a-f0-9]{64}$/.test(contentSha256)) throw new Error(`Invalid source SHA-256: ${contentSha256}`);
    const directory = this.directory(contentSha256);
    try {
      const [rawManifest, content] = await Promise.all([
        fs.readFile(path.join(directory, "manifest.json"), "utf8"),
        fs.readFile(path.join(directory, "source.utf8")),
      ]);
      const manifest = JSON.parse(rawManifest) as SourceMaterialManifest;
      if (manifest.version !== 1) throw new Error(`Unsupported source material manifest: ${directory}`);
      const actual = sourceMaterialIdentity(content);
      assertIdentity({ identity: actual }, manifest);
      if (manifest.contentSha256 !== contentSha256) throw new Error(`Source material path mismatch: ${directory}`);
      return { identity: actual, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private directory(contentSha256: string): string {
    return path.join(this.root, contentSha256);
  }
}

export async function readSourceMaterial(workspaceRoot: string, source: SourceDocument): Promise<Buffer> {
  const store = new SourceMaterialStore();
  const archived = await store.read(source);
  if (archived) return archived;
  if (source.sourcePath.startsWith("content:")) {
    throw new Error(`Archived source material is missing for ${source.id}.`);
  }
  const absolute = path.resolve(workspaceRoot, source.sourcePath);
  const relative = path.relative(path.resolve(workspaceRoot), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Source escaped the workspace: ${source.sourcePath}`);
  const content = await fs.readFile(absolute);
  const identity = sourceMaterialIdentity(content);
  if (identity.contentSha256 !== source.contentSha256) {
    throw new Error(`Source ${source.sourcePath} changed after ingest; expected ${source.contentSha256}, found ${identity.contentSha256}.`);
  }
  await store.put(content, source.title);
  return content;
}

export function sourceMaterialIdentity(content: Uint8Array): SourceMaterialIdentity {
  const buffer = Buffer.from(content);
  return {
    contentMd5: crypto.createHash("md5").update(buffer).digest("hex"),
    contentSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.byteLength,
  };
}

function assertUtf8Text(content: Buffer, label: string): void {
  if (content.subarray(0, 8_000).includes(0)) throw new Error(`Source must be UTF-8 text: ${label}`);
  const decoded = content.toString("utf8");
  if (Buffer.from(decoded, "utf8").compare(content) !== 0) throw new Error(`Source must be valid UTF-8 text: ${label}`);
}

function assertIdentity(
  material: { identity: SourceMaterialIdentity },
  expected: SourceMaterialIdentity,
): void {
  if (
    material.identity.contentSha256 !== expected.contentSha256
    || material.identity.contentMd5 !== expected.contentMd5
    || material.identity.bytes !== expected.bytes
  ) {
    throw new Error(`Source material integrity mismatch for ${expected.contentSha256}.`);
  }
}
