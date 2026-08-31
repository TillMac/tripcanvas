# Agent edits are applied-but-pending

Agent tool calls mutate the same store the human edits, immediately — the map and schedule always show one truth — but every agent-made change carries a pending mark and its source until the human accepts or reverts it; editing a pending stop is an implicit accept, and one undo history covers both actors. Chosen over a staged changeset (a second state, and every read tool must choose which one to report) and over plain apply+undo (which loses the reviewable-edits story the WebMCP spec's own examples call for).
