"use client";

/* The landing hero's double-pass wobble underline (h1-u), ported verbatim.
   Stretches to its container (preserveAspectRatio none); ink = currentColor.
   Wrap in <InkDraw> to animate the two passes drawing in. */
export function InkUnderline({ className, width = "100%" }: { className?: string; width?: string | number }) {
  return (
    <svg
      className={className}
      viewBox="0 0 320 14"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ width, height: 14, display: "block" }}
    >
      <path
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        d="M4 9 C60 5.6 150 8.2 230 6 C265 5.2 295 7.2 316 5.8"
      />
      <path
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        opacity={0.45}
        d="M10 11.4 C80 8.4 180 10.6 312 8.2"
      />
    </svg>
  );
}
