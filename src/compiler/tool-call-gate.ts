export type CompilerToolGateResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  terminate?: boolean;
};

export type CompilerToolCallGate = () => CompilerToolGateResult | undefined;
