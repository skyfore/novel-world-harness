/**
 * Host-only runaway safety fuses for model-driven compiler work. These are
 * intentionally generous during MVP validation and must not be presented to
 * the model as semantic budgets. Evidence, scope, schema, and deterministic
 * commitment boundaries remain enforced elsewhere.
 */
export const COMPILER_TOOL_CALL_SAFETY_FUSE = 1_000;
export const COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE = 800;
export const COMPILER_FINISH_GRACE_CALLS = 1;
export const COMPILER_RETRIEVAL_MAX_FIND_RESULTS = 200;
export const COMPILER_RETRIEVAL_MAX_READ_CHARS = 120_000;
export const COMPILER_PROMPT_TIMEOUT_MS = 60 * 60 * 1_000;
