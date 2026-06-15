"use client";

/* The clean Socheli mark (mk-clean): filled star + breakaway spark. The spark
   carries .ink-spark-detach so it nudges away on .ink-mark hover/focus (the
   landing's "breakaway" gesture). Ink = currentColor from the usage site. */
export function SparkMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span className={`ink-mark ${className ?? ""}`} style={{ display: "inline-flex", lineHeight: 0 }}>
      <svg width={size} height={Math.round((size * 100) / 110)} viewBox="0 0 110 100" aria-hidden="true">
        <path
          fill="currentColor"
          d="M50 3 C55 32.5 66 44 86 47 L78.5 50 L86 53 C66 56 55 67.5 50 97 C45 67.5 32.5 55 3 50 C32.5 45 45 32.5 50 3 Z"
        />
        <path className="ink-spark-detach" fill="currentColor" d="M91 50 L99 45.6 L107 50 L99 54.4 Z" />
      </svg>
    </span>
  );
}
