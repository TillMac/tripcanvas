// Shared tool-result helpers: every failure is an explanatory ERROR string;
// nothing ever throws raw to the agent.
import { z } from "zod";

/** Stop-id argument: get_itinerary prints ids as `[s3]`, so accept "s3", "[s3]" or "S3". */
export const sidArg = z.string().min(1).transform((x) => x.trim().replace(/^\[|\]$/g, "").toLowerCase());

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
