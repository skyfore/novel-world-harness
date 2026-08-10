# Pi integration boundary

Pi remains in the design because it solves the generic agent-runtime problems that Novel World Harness should not reimplement:

- provider and model selection;
- streaming assistant and tool-call events;
- multi-turn agent execution;
- append-only sessions and continuation;
- thinking-level handling and future compaction support.

Novel World Harness owns the parts specific to executable fiction:

- the evidence-first system prompt;
- trusted `NOVEL.md` and local instruction loading;
- safe local list/search/read tools;
- compiler job and readiness semantics;
- proposal/validation/commit boundaries;
- future canon replay and world invariants.

The previous direct Anthropic SDK implementation coupled the CLI to one provider and duplicated session/tool-loop behavior already available in Pi. The current adapter resolves the configured profile through Pi and can register a custom provider endpoint when `baseUrl` and `apiProtocol` are supplied.

“Remove external services” applies to the external persistence layer in Phase 0: PostgreSQL and other attached databases are removed. It does not require removing Pi or forcing the official Claude API. A remote model is still optional infrastructure selected by the user; all harness state and retrieval stay file-based.

For safety, the Pi session disables built-in coding tools and extension discovery. Only Novel Harness's three custom read-only local tools are active. Model content cannot write files, execute a shell, access the network as a tool, or commit world state.
