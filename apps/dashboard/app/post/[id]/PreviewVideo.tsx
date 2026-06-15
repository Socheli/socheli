"use client";

import { VideoPlayer } from "../../VideoPlayer";

/* Rendered-post preview. Uses the custom perf-safe player: lazy metadata load,
   single-playback manager, auto-pause off-screen, full pro controls. autoPlay
   starts muted only while in view. */
export function PreviewVideo({ id, aspect }: { id: string; aspect?: number }) {
  return <VideoPlayer src={`/api/video/${id}`} poster={`/api/thumb/${id}`} aspect={aspect} autoPlay loop fps={30} />;
}
