import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import {
  evidenceAssertionSchema,
  idSchema,
  type EvidenceAssertion,
  type ValidationIssue,
} from "../world/model.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { jsonPointerExists } from "./text-anchors.js";

const bindingSchema = z.object({
  version: z.literal(1),
  artifactKind: idSchema,
  artifactId: idSchema,
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  assertions: z.array(z.object({
    id: idSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
}).strict();
type EvidenceAssertionBinding = z.infer<typeof bindingSchema>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Exact evidence is versioned independently from semantic artifact content so
 * a compiler run/provenance change does not manufacture a new world revision.
 * The binding is replaced only after all immutable assertion revisions exist.
 */
export class EvidenceAssertionStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "compiler", "evidence", "v1");
  }

  async replaceForArtifact(
    artifactKindInput: string,
    artifactIdInput: string,
    artifactHash: string,
    assertionsInput: readonly EvidenceAssertion[],
  ): Promise<void> {
    const artifactKind = safeId(artifactKindInput, "artifact kind");
    const artifactId = safeId(artifactIdInput, "artifact id");
    if (!/^[a-f0-9]{64}$/.test(artifactHash)) throw new Error(`Invalid artifact hash: ${artifactHash}`);
    const assertions = assertionsInput.map((assertion) => evidenceAssertionSchema.parse(assertion));
    if (new Set(assertions.map((assertion) => assertion.id)).size !== assertions.length) {
      throw new Error(`Exact evidence binding for ${artifactKind}/${artifactId} contains duplicate assertion IDs.`);
    }
    const sourceIds = evidenceAssertionSourceIds(assertions);
    if (sourceIds.length > 1) {
      throw new Error(
        `Exact evidence binding for ${artifactKind}/${artifactId} mixes novel sources: ${sourceIds.join(", ")}.`,
      );
    }
    for (const assertion of assertions) {
      if (assertion.target.artifactKind !== artifactKind || assertion.target.artifactId !== artifactId) {
        throw new Error(
          `Evidence assertion ${assertion.id} targets ${assertion.target.artifactKind}/${assertion.target.artifactId}, expected ${artifactKind}/${artifactId}.`,
        );
      }
    }
    const refs: EvidenceAssertionBinding["assertions"] = [];
    for (const assertion of assertions) {
      const hash = contentHash(assertion);
      await writeImmutable(this.revisionPath(assertion.id, hash), assertion);
      refs.push({ id: assertion.id, hash });
    }
    await atomicJson(this.bindingPath(artifactKind, artifactId), {
      version: 1,
      artifactKind,
      artifactId,
      artifactHash,
      assertions: refs,
    } satisfies EvidenceAssertionBinding);
  }

  async listForArtifact(artifactKindInput: string, artifactIdInput: string): Promise<EvidenceAssertion[]> {
    const artifactKind = safeId(artifactKindInput, "artifact kind");
    const artifactId = safeId(artifactIdInput, "artifact id");
    let binding: EvidenceAssertionBinding;
    try {
      binding = bindingSchema.parse(JSON.parse(await fs.readFile(this.bindingPath(artifactKind, artifactId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const assertions: EvidenceAssertion[] = [];
    for (const ref of binding.assertions) {
      const value = evidenceAssertionSchema.parse(JSON.parse(await fs.readFile(this.revisionPath(ref.id, ref.hash), "utf8")));
      if (contentHash(value) !== ref.hash) {
        throw new Error(`Corrupt evidence assertion revision ${ref.id}@${ref.hash}.`);
      }
      assertions.push(value);
    }
    return assertions;
  }

  async bindingForArtifact(
    artifactKindInput: string,
    artifactIdInput: string,
  ): Promise<{ artifactHash: string; assertions: EvidenceAssertion[] } | null> {
    const artifactKind = safeId(artifactKindInput, "artifact kind");
    const artifactId = safeId(artifactIdInput, "artifact id");
    try {
      const binding = bindingSchema.parse(JSON.parse(
        await fs.readFile(this.bindingPath(artifactKind, artifactId), "utf8"),
      ));
      return {
        artifactHash: binding.artifactHash,
        assertions: await this.listForArtifact(artifactKind, artifactId),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private revisionPath(idInput: string, hash: string): string {
    return path.join(this.root, "revisions", safeId(idInput, "assertion id"), `${hash}.json`);
  }

  private bindingPath(artifactKind: string, artifactId: string): string {
    return path.join(this.root, "bindings", artifactKind, `${artifactId}.json`);
  }
}

export function validateEvidenceAssertionTargets(
  artifactKind: string,
  artifactId: string,
  payload: unknown,
  assertions: readonly EvidenceAssertion[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < assertions.length; index += 1) {
    const assertion = assertions[index]!;
    const pathPrefix = `evidenceAssertions.${index}`;
    if (ids.has(assertion.id)) {
      issues.push(issue("DUPLICATE_EVIDENCE_ASSERTION", `Duplicate evidence assertion id ${assertion.id}.`, `${pathPrefix}.id`));
    }
    ids.add(assertion.id);
    if (assertion.target.artifactKind !== artifactKind || assertion.target.artifactId !== artifactId) {
      issues.push(issue(
        "EVIDENCE_TARGET_MISMATCH",
        `Evidence assertion targets ${assertion.target.artifactKind}/${assertion.target.artifactId}, expected ${artifactKind}/${artifactId}.`,
        `${pathPrefix}.target`,
      ));
    }
    if (!jsonPointerExists(payload, assertion.target.jsonPointer)) {
      issues.push(issue(
        "UNKNOWN_EVIDENCE_TARGET_PATH",
        `Evidence assertion target path '${assertion.target.jsonPointer}' does not exist in the proposal payload.`,
        `${pathPrefix}.target.jsonPointer`,
      ));
    }
  }
  return issues;
}

export function evidenceAssertionSourceIds(assertions: readonly EvidenceAssertion[]): string[] {
  return [...new Set(assertions.flatMap((assertion) => assertion.anchors.map((anchor) => anchor.sourceId)))].sort();
}

async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) {
      throw new Error(`Evidence assertion revision already exists with different content: ${filePath}`);
    }
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value) || value.length > 200) throw new Error(`Unsafe ${label}: ${value}`);
  return value;
}

function issue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path };
}
