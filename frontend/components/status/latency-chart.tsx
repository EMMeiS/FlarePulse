import type { SeriesPoint } from "../../../src/status";
import { formatLatency } from "@/lib/format";

// Chart space, not pixels: the SVG stretches to its container and the strokes
// keep their width via vector-effect.
const WIDTH = 600;
const HEIGHT = 120;

interface Run {
  d: string;
  area: string;
}

/**
 * One path per contiguous run of samples. A bucket with no successful check has
 * no latency, and drawing straight through it would invent a measurement.
 */
function runs(points: SeriesPoint[], pick: (point: SeriesPoint) => number | null, max: number): Run[] {
  const x = (index: number) => (index / Math.max(1, points.length - 1)) * WIDTH;
  const y = (value: number) => HEIGHT - (value / max) * HEIGHT;

  const result: Run[] = [];
  let current: string[] = [];
  let startX = 0;

  const flush = (endX: number) => {
    if (current.length > 1) {
      const d = `M ${current.join(" L ")}`;
      result.push({ d, area: `${d} L ${endX},${HEIGHT} L ${startX},${HEIGHT} Z` });
    }
    current = [];
  };

  points.forEach((point, index) => {
    const value = pick(point);
    if (value === null) {
      flush(x(index - 1));
      return;
    }
    if (current.length === 0) startX = x(index);
    current.push(`${x(index)},${y(value)}`);
  });
  flush(x(points.length - 1));

  return result;
}

/**
 * p50 and p95 for the selected window. Hand-written SVG rather than a chart
 * library: two series and a fixed axis is less code than a dependency, and it
 * ships inside the same bundle the Worker already serves.
 */
export function LatencyChart({ points }: { points: SeriesPoint[] }) {
  const values = points.flatMap((point) =>
    [point.latency_p50, point.latency_p95].filter((value): value is number => value !== null),
  );
  if (values.length === 0) {
    return <p className="text-muted-foreground text-xs">No response times recorded yet.</p>;
  }

  const max = Math.max(...values);
  const p95 = runs(points, (point) => point.latency_p95, max);
  const p50 = runs(points, (point) => point.latency_p50, max);

  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label={`Response time, p50 and p95, peaking at ${formatLatency(max)}`}
      >
        {p95.map((run) => (
          <path key={`a${run.d}`} d={run.area} className="fill-primary/10" />
        ))}
        {p95.map((run) => (
          <path
            key={`p95${run.d}`}
            d={run.d}
            fill="none"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            className="stroke-primary/40"
          />
        ))}
        {p50.map((run) => (
          <path
            key={`p50${run.d}`}
            d={run.d}
            fill="none"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            className="stroke-primary"
          />
        ))}
      </svg>
      <figcaption className="text-muted-foreground flex justify-between text-xs tabular-nums">
        <span>p50 — p95</span>
        <span>{`peak ${formatLatency(max)}`}</span>
      </figcaption>
    </figure>
  );
}
