import { z } from "zod";
export const FreeEventSchema = z.object({
  id: z.string(),
  day: z.number().int().min(1),
  afterStopId: z.string().nullable(),
  durationMin: z.number().int().min(0),
  label: z.string().optional(),
});
export type FreeEvent = z.infer<typeof FreeEventSchema>;
