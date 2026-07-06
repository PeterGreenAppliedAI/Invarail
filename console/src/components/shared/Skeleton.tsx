const WIDTHS = ['w-full', 'w-5/6', 'w-2/3'];

/** Minimal pulsing-bar loading placeholder. */
export default function Skeleton({ rows = 3, className = '' }: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={`animate-pulse space-y-3 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`h-4 bg-zinc-800 rounded ${WIDTHS[i % WIDTHS.length]}`} />
      ))}
    </div>
  );
}
