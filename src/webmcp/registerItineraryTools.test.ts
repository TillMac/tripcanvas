// Primary test seam (spec: Testing Decisions): a fake document.modelContext
// captures registrations; tests call each tool's execute with plain args and
// assert the returned string.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RegisterToolOptions } from "./modelContext.js";

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
    expect(register()).toBe(false);
  });

  it("registers get_planning_guide with readOnlyHint and executes to the guide text", async () => {
    const captured: RegisterToolOptions[] = [];
    const register = await freshRegister({ registerTool: (o) => captured.push(o) });
    expect(register()).toBe(true);

    const guide = captured.find((t) => t.name === "get_planning_guide");
    expect(guide).toBeDefined();
    expect(guide!.annotations?.readOnlyHint).toBe(true);
    expect(guide!.description.length).toBeLessThanOrEqual(500);
    expect(guide!.name.length).toBeLessThanOrEqual(30);

    const result = await guide!.execute({});
    expect(result).toContain("PLANNING GUIDE");
    expect(result).toContain("temple/shrine 40-60");
    expect(result.length).toBeLessThanOrEqual(1500);
  });

  it("registers only once across repeated calls (HMR/StrictMode guard)", async () => {
    const captured: RegisterToolOptions[] = [];
    const register = await freshRegister({ registerTool: (o) => captured.push(o) });
    register();
    register();
    expect(captured.filter((t) => t.name === "get_planning_guide")).toHaveLength(1);
  });
});
