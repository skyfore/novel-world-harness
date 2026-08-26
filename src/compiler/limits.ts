/**
 * Capacity budgets for model-driven compiler work. These are intentionally
 * generous during MVP validation; evidence, scope, schema, and deterministic
 * commitment boundaries remain enforced elsewhere.
 */
export const COMPILER_TOOL_CALL_LIMIT = 200;
export const COMPILER_ACTIVE_PROPOSAL_LIMIT = 160;
export const COMPILER_ACTIVE_PROPOSAL_TARGET = 150;
export const COMPILER_FINISH_GRACE_CALLS = 1;
export const COMPILER_RETRIEVAL_MAX_FIND_RESULTS = 200;
export const COMPILER_RETRIEVAL_MAX_READ_CHARS = 120_000;
export const COMPILER_PROMPT_TIMEOUT_MS = 30 * 60 * 1_000;
