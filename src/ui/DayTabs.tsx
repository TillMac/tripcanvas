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
    <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-white px-3 py-2">
      {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
        <button
          type="button"
          key={d}
          aria-label={`Day ${d}`}
          className={`rounded-full px-3 py-1 text-xs ${
            d === active
              ? "border border-teal-700 bg-teal-700 font-semibold text-white"
              : "border border-transparent bg-slate-100 font-medium text-slate-600 hover:bg-slate-200"
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
          className="rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-500 hover:border-teal-600 hover:text-teal-700"
          onClick={onAddDay}
        >
          + day
        </button>
      )}
    </div>
  );
}
