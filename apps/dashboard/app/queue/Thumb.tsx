"use client";
import { useState } from "react";

/* Queue thumbnail. We only attempt the poster <img> when the render actually
   exists on disk (hasVideo, computed server-side). Even then, if the thumb
   endpoint 404s or ffmpeg hasn't produced a frame yet, onError falls back to
   the placeholder instead of leaving a broken black box. While a post is still
   being generated we show an animated placeholder rather than an empty frame. */
export function Thumb({ id, hasVideo, channel, generating }: { id: string; hasVideo: boolean; channel?: string; generating?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (hasVideo && !failed) {
    return <img src={`/api/thumb/${id}`} alt="" onError={() => setFailed(true)} />;
  }
  return (
    <span className={`thumb-ph${generating ? " thumb-gen" : ""}`}>
      {generating ? <span className="thumb-spin" /> : channel?.[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
