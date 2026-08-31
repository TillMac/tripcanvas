# Planning logic lives in the page, not in the agent

The agent supplies place names; the page does geocoding, day clustering, ordering, travel-time matrices and scheduling deterministically. The predecessor project put these rules in an LLM skill prompt (`skills/travel-planner/SKILL.md`). WebMCP has no skill file, Chrome truncates tool descriptions, and judges use whichever model their browser ships — so any rule that matters must be code, and tool descriptions only say *what* a tool does, never *how to plan*.

## Consequences

Tool descriptions stay short and stable; planning quality is testable with vitest instead of eval prompts; the same functions back both the agent's tools and the human's buttons.
