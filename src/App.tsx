interface AppProps {
  agentAvailable: boolean;
}

export default function App({ agentAvailable }: AppProps) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {!agentAvailable && (
        <div className="bg-amber-100 text-amber-900 px-4 py-2 text-sm">
          Your browser has no WebMCP agent — tripcanvas works as a manual
          planner. In Chrome 149+, enable chrome://flags/#enable-webmcp-testing
          to let a browser agent co-edit this trip.
        </div>
      )}
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-semibold">tripcanvas</h1>
        <p className="mt-4 text-slate-600">
          One shared trip itinerary on a live map, edited by you and your
          browser agent together.
        </p>
        <p className="mt-8 rounded border border-dashed border-slate-300 px-4 py-6 text-slate-500">
          Try: ask your agent to plan 3 days in Tokyo.
        </p>
      </main>
    </div>
  );
}
