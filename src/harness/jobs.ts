import type { Db } from "../db/client.js";
import type { HarnessJob, HarnessJobType } from "./types.js";

export async function enqueueJob(
  db: Db,
  projectId: string,
  jobType: HarnessJobType,
  input: unknown,
  priority = 0.5,
  targetType?: string,
  targetId?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO harness_jobs(project_id, job_type, target_type, target_id, priority, input)
     SELECT $1, $2, $3, $4, $5, $6::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM harness_jobs
       WHERE project_id = $1 AND job_type = $2
         AND COALESCE(target_type, '') = COALESCE($3, '')
         AND COALESCE(target_id, '') = COALESCE($4, '')
         AND status IN ('pending', 'running')
     )`,
    [projectId, jobType, targetType ?? null, targetId ?? null, priority, JSON.stringify(input ?? {})],
  );
}

export async function claimNextJob(db: Db, projectId: string): Promise<HarnessJob | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id, job_type, target_type, target_id, priority, input
       FROM harness_jobs
       WHERE project_id = $1 AND status = 'pending'
       ORDER BY priority DESC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [projectId],
    );
    if (!result.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const row = result.rows[0];
    await client.query(
      `UPDATE harness_jobs SET status = 'running', attempts = attempts + 1, started_at = now() WHERE id = $1`,
      [row.id],
    );
    await client.query("COMMIT");
    return {
      id: row.id,
      jobType: row.job_type,
      targetType: row.target_type ?? undefined,
      targetId: row.target_id ?? undefined,
      priority: Number(row.priority),
      input: row.input,
    } as HarnessJob;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finishJob(db: Db, jobId: string, output: unknown): Promise<void> {
  await db.query(
    `UPDATE harness_jobs SET status = 'done', output = $2::jsonb, finished_at = now(), error = NULL WHERE id = $1`,
    [jobId, JSON.stringify(output ?? {})],
  );
}

export async function failJob(db: Db, jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await db.query(
    `UPDATE harness_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
    [jobId, message],
  );
}
