export function DayTabs({
  dayCount,
  active,
  onSelect,
  onAddDay,
}: {
  dayCount: number;
  active: number;
  onSelect: (d: number) => void;
  onAddDay?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 p-2">
      {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
        <button
          type="button"
          key={d}
          aria-label={`Day ${d}`}
          className={`rounded-full border px-3 py-1 text-xs ${
            d === active
              ? "border-blue-600 bg-blue-600 font-semibold text-white"
              : "border-slate-300 bg-slate-50 text-slate-600 hover:border-slate-400"
          }`}
          onClick={() => onSelect(d)}
        >
          Day {d}
        </button>
      ))}
      {onAddDay && dayCount < 7 && (
        <button
          type="button"
          aria-label="Add a day"
          className="rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-500 hover:border-slate-400"
          onClick={onAddDay}
        >
          + day
        </button>
      )}
    </div>
  );
}
