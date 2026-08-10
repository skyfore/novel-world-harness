import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import { jobTypes, type BuildMetrics, type HarnessJob, type HarnessJobType } from "../harness/types.js";

const STATE_VERSION = 1;

const EMPTY_METRICS: BuildMetrics = {
  source: 0,
  evidence: 0,
  entityResolution: 0,
  majorEvents: 0,
  temporalConsistency: 0,
  stateDelta: 0,
  epistemic: 0,
  causality: 0,
};

export type StoredProject = {
  version: 1;
  id: string;
  name: string;
  language: string;
  status: "compiling" | "ready";
  createdAt: string;
  updatedAt: string;
};

export type SourceDocument = {
  version: 1;
  id: string;
  title: string;
  sourcePath: string;
  contentSha256: string;
  bytes: number;
  registeredAt: string;
  updatedAt: string;
};

export type StoredJob = HarnessJob & {
  version: 1;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  output?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
};

type StoredMetrics = {
  version: 1;
  values: BuildMetrics;
  details: Partial<Record<keyof BuildMetrics, unknown>>;
  updatedAt: string;
};

function slugify(input: string): string {
  return (
    input
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "world"
  );
}

function stateFileName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) throw new Error(`Invalid local state id: ${value}`);
  return `${value}.json`;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, filePath);
}

export class WorkspaceStore {
  readonly root: string;
  readonly stateDir: string;
  private readonly sourcesDir: string;
  private readonly jobsDir: string;

  private constructor(root: string) {
    this.root = root;
    this.stateDir = path.join(root, ".novel-harness");
    this.sourcesDir = path.join(this.stateDir, "sources");
    this.jobsDir = path.join(this.stateDir, "jobs");
  }

  static async create(root = process.cwd()): Promise<WorkspaceStore> {
    const realRoot = await fs.realpath(path.resolve(root));
    const stat = await fs.stat(realRoot);
    if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
    return new WorkspaceStore(realRoot);
  }

  async ensureProject(project: HarnessConfig["project"]): Promise<StoredProject> {
    const filePath = path.join(this.stateDir, "project.json");
    const existing = await readJson<StoredProject>(filePath);
    const now = new Date().toISOString();
    const next: StoredProject = {
      version: STATE_VERSION,
      id: slugify(project.name),
      name: project.name,
      language: project.language,
      status: existing?.status ?? "compiling",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await atomicJson(filePath, next);
    await this.ensureMetrics();
    return next;
  }

  async readProject(): Promise<StoredProject | null> {
    return readJson<StoredProject>(path.join(this.stateDir, "project.json"));
  }

  async registerSource(inputPath: string): Promise<SourceDocument> {
    const absolute = await fs.realpath(path.resolve(inputPath));
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === ".novel-harness") {
      throw new Error("Source files must be inside the novel workspace.");
    }
    if (relative.split(path.sep).includes(".novel-harness")) {
      throw new Error("Harness state cannot be registered as source material.");
    }
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`Source is not a file: ${inputPath}`);
    const content = await fs.readFile(absolute);
    if (content.subarray(0, 8_000).includes(0)) throw new Error(`Source must be UTF-8 text: ${inputPath}`);
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const id = sha.slice(0, 20);
    const filePath = path.join(this.sourcesDir, stateFileName(id));
    const existing = await readJson<SourceDocument>(filePath);
    const now = new Date().toISOString();
    const source: SourceDocument = {
      version: STATE_VERSION,
      id,
      title: path.basename(absolute),
      sourcePath: relative.split(path.sep).join("/"),
      contentSha256: sha,
      bytes: content.byteLength,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    await atomicJson(filePath, source);
    return source;
  }

  async getSource(id: string): Promise<SourceDocument | null> {
    return readJson<SourceDocument>(path.join(this.sourcesDir, stateFileName(id)));
  }

  async listSources(): Promise<SourceDocument[]> {
    return this.readDirectory<SourceDocument>(this.sourcesDir, (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath),
    );
  }

  async enqueueJob(
    jobType: HarnessJobType,
    input: unknown,
    priority = 0.5,
    targetType?: string,
    targetId?: string,
  ): Promise<StoredJob> {
    if (!jobTypes.includes(jobType)) throw new Error(`Unknown job type: ${jobType}`);
    const stableKey = JSON.stringify([jobType, targetType ?? "", targetId ?? ""]);
    const id = `${jobType}-${crypto.createHash("sha256").update(stableKey).digest("hex").slice(0, 16)}`;
    const filePath = path.join(this.jobsDir, stateFileName(id));
    const existing = await readJson<StoredJob>(filePath);
    if (existing && ["pending", "running", "done"].includes(existing.status)) return existing;
    const now = new Date().toISOString();
    const job: StoredJob = {
      version: STATE_VERSION,
      id,
      jobType,
      targetType,
      targetId,
      priority,
      input,
      status: "pending",
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await atomicJson(filePath, job);
    return job;
  }

  async listJobs(): Promise<StoredJob[]> {
    return this.readDirectory<StoredJob>(this.jobsDir, (left, right) => {
      if (left.priority !== right.priority) return right.priority - left.priority;
      return left.createdAt.localeCompare(right.createdAt);
    });
  }

  async claimNextJob(): Promise<StoredJob | null> {
    const job = (await this.listJobs()).find((candidate) => candidate.status === "pending");
    if (!job) return null;
    const now = new Date().toISOString();
    const claimed: StoredJob = {
      ...job,
      status: "running",
      attempts: job.attempts + 1,
      startedAt: now,
      updatedAt: now,
      error: undefined,
    };
    await atomicJson(path.join(this.jobsDir, stateFileName(job.id)), claimed);
    return claimed;
  }

  async finishJob(id: string, output: unknown): Promise<void> {
    await this.updateJob(id, { status: "done", output, error: undefined });
  }

  async failJob(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await this.updateJob(id, { status: "failed", error: message });
  }

  async readMetrics(): Promise<BuildMetrics> {
    return (await this.ensureMetrics()).values;
  }

  async writeMetric(metric: keyof BuildMetrics, value: number, details: unknown = {}): Promise<void> {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Metric ${metric} must be between 0 and 1.`);
    }
    const metrics = await this.ensureMetrics();
    metrics.values[metric] = value;
    metrics.details[metric] = details;
    metrics.updatedAt = new Date().toISOString();
    await atomicJson(path.join(this.stateDir, "metrics.json"), metrics);
  }

  private async ensureMetrics(): Promise<StoredMetrics> {
    const filePath = path.join(this.stateDir, "metrics.json");
    const existing = await readJson<StoredMetrics>(filePath);
    if (existing) return existing;
    const metrics: StoredMetrics = {
      version: STATE_VERSION,
      values: { ...EMPTY_METRICS },
      details: {},
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(filePath, metrics);
    return metrics;
  }

  private async updateJob(
    id: string,
    patch: Pick<StoredJob, "status"> & Partial<Pick<StoredJob, "output" | "error">>,
  ): Promise<void> {
    const filePath = path.join(this.jobsDir, stateFileName(id));
    const job = await readJson<StoredJob>(filePath);
    if (!job) throw new Error(`Harness job not found: ${id}`);
    const now = new Date().toISOString();
    await atomicJson(filePath, { ...job, ...patch, finishedAt: now, updatedAt: now });
  }

  private async readDirectory<T>(
    directory: string,
    compare: (left: T, right: T) => number,
  ): Promise<T[]> {
    try {
      const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
      const values: T[] = [];
      for (const name of files) {
        const value = await readJson<T>(path.join(directory, name));
        if (value !== null) values.push(value);
      }
      return values.sort(compare);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
