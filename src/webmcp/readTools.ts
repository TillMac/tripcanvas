// The read tools + revert_pending (docs/design/tool-layer.md §2, T8).
// get_itinerary/get_changes advance the agent's read cursor (bookkeeping only;
// readOnlyHint stays honest). revert_pending touches the agent's own
// still-pending edits only.
import { z } from "zod";
import { changesPage, renderAgentView } from "../store/handback.js";
import { editStatus, pendingEdits } from "../store/store.js";
import type { RegisterToolOptions } from "./modelContext.js";
import { err, wrap } from "./result.js";
import type { ToolDeps } from "./tools.js";

export function buildReadTools(deps: ToolDeps): RegisterToolOptions[] {
  const { trip } = deps;
  const state = () => trip.store.getState();

  const getItinerary: RegisterToolOptions = {
    name: "get_itinerary",
    description:
      "Read the whole trip: each day's ordered stops with arrival times, dwell, leg mode and minutes, lodging per night, candidates (places on no day), and warnings (past-22:00 overflow, legs over 40 min). Every read also lists what the human changed since your last read and which of your edits are still pending review. Call it before editing and again after the human touches the map. Stops are addressed by the [s#]/[c#] ids it prints. Pass day for one day in full detail on long trips.",
    inputSchema: {
      type: "object",
      properties: {
        day: {
          type: "number",
          description: "1-based day to read alone in full detail. Omit for the whole trip; trips over 4 days auto-compact to per-day one-liners.",
        },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: wrap((args) => {
      const p = z.object({ day: z.number().int().optional() }).safeParse(args);
      if (!p.success) return err("day must be a whole number.");
      const out = renderAgentView(state(), p.data.day);
      if (!out.startsWith("ERROR")) trip.actions.advanceAgentRead();
      return out;
    }),
  };

  const getChanges: RegisterToolOptions = {
    name: "get_changes",
    description:
      "List every change since a revision: who made it (human or agent), what changed, and the fate of each of your edits — pending, accepted, or reverted. Defaults to everything since your last get_itinerary or get_changes call. Use it after a pause to see what the human did, and before building on your own pending edits. Returns 'No changes since rev N.' when quiet; if the revision is older than kept history it returns the full itinerary instead.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", minimum: 0, description: "Revision to list changes after (from an earlier result). Default: your last read." },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: wrap((args) => {
      const p = z.object({ since: z.number().int().min(0).optional() }).safeParse(args);
      if (!p.success) return err("since must be a whole number revision.");
      const s = state();
      const page = changesPage(s, p.data.since ?? s.lastAgentReadRev);
      trip.actions.advanceAgentRead(page.readTo);
      return page.text;
    }),
  };

  const revertPending: RegisterToolOptions = {
    name: "revert_pending",
    description:
      "Revert your own pending edits — ones the human has not yet accepted or built on. Pass edit ids from get_changes, or all:true for every pending edit of yours. An edit whose stops the human already touched is accepted and stays; the rest of the edit is restored exactly. Never touches human-made changes; ask the human to undo those instead.",
    inputSchema: {
      type: "object",
      properties: {
        edits: { type: "array", items: { type: "string" }, description: "Pending edit ids from get_changes, e.g. ['e12']." },
        all: { type: "boolean", description: "Revert every pending edit of yours." },
      },
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: wrap((args) => {
      const p = z
        .object({ edits: z.array(z.string()).optional(), all: z.boolean().optional() })
        .safeParse(args);
      if (!p.success) return err("pass edits: ['e12', ...] or all: true.");
      const s = state();
      const targets = p.data.all ? pendingEdits(s).map((x) => x.editId) : (p.data.edits ?? []);
      if (p.data.all && targets.length === 0) return err("no pending edits.");
      if (targets.length === 0) return err("pass edits: ['e12', ...] or all: true.");

      const reverted: string[] = [];
      const notes: string[] = [];
      for (const e of targets) {
        const st = editStatus(state(), e);
        if (!st) {
          notes.push(`${e}: no such edit — ids come from get_changes.`);
          continue;
        }
        const r = trip.actions.revert("agent", e);
        if ("error" in r) {
          if (targets.length === 1) return err(r.error);
          notes.push(`${e}: ${r.error}`);
          continue;
        }
        reverted.push(e);
        if (r.kept.length > 0) {
          const total = r.kept.length + r.reverted.length;
          notes.push(
            `${e}: ${r.reverted.length} of ${total} stops reverted; ${r.kept.map((x) => `[${x}]`).join(" ")} was accepted by the human and stays.`,
          );
        }
      }
      if (reverted.length === 0) return err(notes.join(" ") || "no pending edits.");
      const s2 = state();
      const still = pendingEdits(s2);
      const stillNote =
        still.length === 0
          ? "No edits still pending."
          : `${still.length} edit${still.length > 1 ? "s" : ""} still pending (${still.map((x) => x.editId).join(", ")}).`;
      return `Reverted ${reverted.join(", ")}; rev now ${s2.rev}. ${stillNote}${notes.length ? ` ${notes.join(" ")}` : ""}`;
    }),
  };

  return [getItinerary, getChanges, revertPending];
}
