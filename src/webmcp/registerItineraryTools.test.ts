// Registration seam: fake document.modelContext captures registrations.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RegisterToolOptions } from "./modelContext.js";
import { createTripStore } from "../store/store.js";
import type { ToolDeps } from "./tools.js";

function fakeDeps(): ToolDeps {
  return {
    trip: createTripStore(),
    matrix: { ensureFresh: async () => {} },
    nominatim: { resolve: async () => ({ ok: false, kind: "error", message: "offline" }) },
  };
}

async function freshRegister(fake: { registerTool: (o: RegisterToolOptions) => void } | undefined) {
  vi.resetModules();
  (document as any).modelContext = fake;
  const mod = await import("./registerItineraryTools.js");
  return mod.registerItineraryTools;
}

describe("registerItineraryTools", () => {
  beforeEach(() => {
    delete (document as any).modelContext;
  });

  it("returns false and registers nothing when WebMCP is absent", async () => {
    const register = await freshRegister(undefined);
    expect(register(fakeDeps())).toBe(false);
  });

  it("registers the T6 tool set with get_planning_guide executable", async () => {
    const captured: RegisterToolOptions[] = [];
    const register = await freshRegister({ registerTool: (o) => captured.push(o) });
    expect(register(fakeDeps())).toBe(true);
    const names = captured.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["add_place", "move_stop", "set_times", "set_lodging", "arrange_days", "get_planning_guide"]),
    );
    const guide = captured.find((t) => t.name === "get_planning_guide")!;
    const result = await guide.execute({});
    expect(result).toContain("PLANNING GUIDE");
    expect(result.length).toBeLessThanOrEqual(1500);
  });

  it("registers only once across repeated calls (HMR/StrictMode guard)", async () => {
    const captured: RegisterToolOptions[] = [];
    const register = await freshRegister({ registerTool: (o) => captured.push(o) });
    const deps = fakeDeps();
    register(deps);
    register(deps);
    expect(captured.filter((t) => t.name === "get_planning_guide")).toHaveLength(1);
  });
});
