// Shared tool-result helpers: every failure is an explanatory ERROR string;
// nothing ever throws raw to the agent.
import type { z } from "zod";

export const err = (msg: string) => `ERROR: ${msg}`;

export function wrap(execute: (args: Record<string, unknown>) => Promise<string> | string) {
  return async (args: Record<string, unknown>): Promise<string> => {
    try {
      return await execute(args ?? {});
    } catch (e) {
      return err(`${e instanceof Error ? e.message : String(e)} — the trip is unchanged, try again.`);
    }
  };
}

export function zodErr(e: z.ZodError): string {
  const i = e.issues[0];
  return err(`invalid ${i.path.join(".") || "arguments"}: ${i.message}`);
}
