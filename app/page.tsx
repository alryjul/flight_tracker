import { FlightMap } from "@/components/FlightMap";

export default function HomePage() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-mark">
          <p className="eyebrow">Ambient Airspace</p>
          <h1>West Hollywood Flight Tracker</h1>
        </div>
        <p className="hero-copy">
          Live overhead traffic with airline and aircraft metadata.
        </p>
      </section>
      <FlightMap />
    </main>
  );
}
