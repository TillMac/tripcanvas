import { z } from "zod";

export const PlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  day: z.number().int().min(1),
  arriveTime: z.string().optional(),
  // 選填：種 widget 停留時間（飯店給 0）。非法值丟欄位但保留 place。
  dwellMin: z.number().optional().catch(undefined),
  // 選填：特殊類型（v1 只有 lodging）。非法值丟欄位但保留 place。
  kind: z.literal("lodging").optional().catch(undefined),
});
export type Place = z.infer<typeof PlaceSchema>;

export function validatePlaces(raw: unknown): { valid: Place[]; dropped: number } {
  const arr = Array.isArray(raw) ? raw : [];
  const valid: Place[] = [];
  let dropped = 0;
  for (const item of arr) {
    const p = PlaceSchema.safeParse(item);
    if (p.success) valid.push(p.data); else dropped++;
  }
  return { valid, dropped };
}
