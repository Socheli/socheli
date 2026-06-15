/* Soli mark — Socheli's assistant. A four-point concave star with a center dot
   and a small secondary spark (ivory/dark family of the Socheli brand).
   Single-color (currentColor) so it themes anywhere. */
export function SoliMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* main 4-point star with a round hole punched out (the ring) */}
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 1.4C12.92 9.04 15 11.08 22.6 12C15 12.92 12.92 15 12 22.6C11.08 15 9 12.92 1.4 12C9 11.08 11.08 9.04 12 1.4ZM12 8.65A3.35 3.35 0 1 0 12 15.35A3.35 3.35 0 1 0 12 8.65Z"
      />
      {/* center dot inside the ring */}
      <circle cx="12" cy="12" r="1.85" fill="currentColor" />
      {/* secondary spark, upper-right — the "alive"/assistant accent */}
      <path
        fill="currentColor"
        d="M19 3.1C19.3 4.55 19.65 4.9 21.1 5.2C19.65 5.5 19.3 5.85 19 7.3C18.7 5.85 18.35 5.5 16.9 5.2C18.35 4.9 18.7 4.55 19 3.1Z"
      />
    </svg>
  );
}

export default SoliMark;
