/**
 * One headline line across years — a single-series bar chart (magnitude over
 * time, one entity → one fixed hue, no legend; the title names the series).
 * Table-first page: this renders NEXT TO the table, never instead of it.
 * Marks: thin bars, rounded data-end anchored to the baseline, 2px surface
 * gaps, direct value labels in ink (never the series color), native tooltips.
 */
const BAR = '#1d4ed8'; // validated: L-band, chroma, 4.5:1+ on white

export function YearBars({ label, points }: { label: string; points: { year: number; value: string }[] }) {
  const nums = points.map((p) => Number(p.value));
  const max = Math.max(...nums.map(Math.abs), 1);
  const W = 220;
  const H = 96;
  const plotH = 64;
  const baseline = 12 + plotH; // labels above, year ticks below
  const bw = Math.min(28, (W - 8) / points.length - 8);
  return (
    <figure className="rounded border border-slate-200 p-3">
      <figcaption className="text-xs font-semibold text-slate-700">{label}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full" role="img" aria-label={`${label} by year`}>
        <line x1={0} y1={baseline} x2={W} y2={baseline} stroke="#e2e8f0" strokeWidth={1} />
        {points.map((p, i) => {
          const v = Number(p.value);
          const h = Math.max(2, (Math.abs(v) / max) * plotH);
          const x = 8 + i * ((W - 16) / points.length) + ((W - 16) / points.length - bw) / 2;
          const y = baseline - h;
          return (
            <g key={p.year}>
              <title>{`${p.year}: ${p.value}`}</title>
              {/* rounded data-end, square baseline end: round the top only */}
              <path
                d={`M ${x} ${baseline} L ${x} ${y + 4} Q ${x} ${y} ${x + 4} ${y} L ${x + bw - 4} ${y} Q ${x + bw} ${y} ${x + bw} ${y + 4} L ${x + bw} ${baseline} Z`}
                fill={BAR}
                opacity={v < 0 ? 0.55 : 1}
              />
              <text x={x + bw / 2} y={y - 3} textAnchor="middle" className="fill-slate-600" fontSize={7}>
                {Intl.NumberFormat('en-US').format(v)}
              </text>
              <text x={x + bw / 2} y={H - 2} textAnchor="middle" className="fill-slate-400" fontSize={7}>
                {p.year}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
