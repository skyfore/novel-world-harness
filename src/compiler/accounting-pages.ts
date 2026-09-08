import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { idSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";

export const accountingPageSchema = z.object({
  version: z.literal(1),
  token: z.string().regex(/^acctpg-[a-f0-9]{16}$/),
  sourceId: idSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  compilerBatchId: idSchema,
  segmentIds: z.array(idSchema).min(1),
  unitIds: z.array(idSchema).min(1).max(512).refine((ids) => new Set(ids).size === ids.length, "page units must be unique"),
  issuedAt: z.string().datetime(),
  consumedBy: idSchema.optional(),
  auditRef: z.string().trim().min(1).optional(),
}).strict();
export type AccountingPage = z.infer<typeof accountingPageSchema>;

/** Compiler-lock-owned protocol receipts; never a source disposition or world fact. */
export class CompilerAccountingPages {
  constructor(private readonly root: string, readonly sourceId: string, readonly batchId: string) {}
  private file(token: string) {
    accountingPageSchema.shape.token.parse(token);
    const scope = crypto.createHash("sha256").update(JSON.stringify([this.sourceId, this.batchId])).digest("hex");
    return path.join(worldStorageRoot(this.root), "compiler", "accounting-pages", scope, `${token}.json`);
  }
  read(token: string): AccountingPage | undefined {
    if (!accountingPageSchema.shape.token.safeParse(token).success) return undefined;
    try {
      const page = accountingPageSchema.parse(JSON.parse(fs.readFileSync(this.file(token), "utf8")));
      if (page.sourceId !== this.sourceId || page.compilerBatchId !== this.batchId || page.token !== token) {
        throw new Error("Compiler accounting page scope mismatch; stop for host repair.");
      }
      return page;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private write(page: AccountingPage) {
    const file = this.file(page.token);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(accountingPageSchema.parse(page), null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  issue(input: Pick<AccountingPage, "sourceSha256" | "segmentIds" | "unitIds">): AccountingPage {
    const page = accountingPageSchema.parse({ ...input, version: 1, sourceId: this.sourceId, compilerBatchId: this.batchId,
      token: `acctpg-${crypto.randomBytes(8).toString("hex")}`, issuedAt: new Date().toISOString() });
    this.write(page);
    return page;
  }
  consume(token: string, proposalId: string) {
    const page = this.read(token);
    if (!page || (page.consumedBy && page.consumedBy !== proposalId)) throw new Error("Accounting page is missing or already consumed; stop for host review.");
    this.write({ ...page, consumedBy: proposalId });
  }
}
