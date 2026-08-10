export type PlayerMode = "canon-character" | "reader-possession" | "observer";

export type ProposedAction = {
  actorId: string;
  intent: string;
  payload: Record<string, unknown>;
};

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export interface WorldRuntime {
  proposeNaturalLanguageAction(actorId: string, input: string): Promise<ProposedAction>;
  validate(action: ProposedAction): Promise<ValidationResult>;
  commit(action: ProposedAction): Promise<void>;
}

// Runtime implementation starts in Phase 2 after canon state replay exists.
// This interface deliberately prevents narrative text from being treated as a state mutation API.
