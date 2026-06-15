"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/* Poster tile that previews the rendered mp4 on hover.
   - the thumb JPEG shows by default (cheap, already lazy-loaded)
   - the heavy mp4 is only attached on first hover (preload="none", src set lazily)
   - it plays muted + looping, restarts from 0 each hover, and pauses on leave
   - non-verified items have no render → just the channel-initial placeholder */
export function LibPoster({
  id,
  verified,
  wide,
  placeholder,
  children,
}: {
  id: string;
  verified: boolean;
  wide: boolean;
  placeholder: string;
  children?: ReactNode;
}) {
  const vref = useRef<HTMLVideoElement>(null);
  const hovering = useRef(false);
  const [active, setActive] = useState(false); // mp4 has been requested at least once
  const [playing, setPlaying] = useState(false); // fade the video in once frames are flowing

  function play() {
    const el = vref.current;
    if (!el) return;
    try { el.currentTime = 0; } catch {}
    // .play() forces the browser to load the source even with preload="none",
    // so this is what actually kicks off playback (and fires onLoadedData).
    void el.play().catch(() => {});
  }

  function enter() {
    if (!verified) return;
    hovering.current = true;
    if (!active) setActive(true); // first hover: mounts the <video>; the effect below plays it once mounted
    else play();                  // already mounted from a prior hover: (re)start immediately
  }

  // On the first hover the <video> isn't in the DOM yet when enter() runs, so
  // vref.current is null and nothing starts it. This effect fires right after the
  // element mounts (active flips true) and plays it if the pointer is still over.
  useEffect(() => {
    if (active && hovering.current) play();
  }, [active]);

  function leave() {
    hovering.current = false;
    setPlaying(false);
    vref.current?.pause();
  }

  return (
    <div
      className={`lib-poster${wide ? " wide" : ""}`}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {verified ? (
        <>
          <img src={`/api/thumb/${id}`} alt="" loading="lazy" />
          {active && (
            <video
              ref={vref}
              src={`/api/video/${id}`}
              muted
              loop
              playsInline
              preload="none"
              className={`lib-poster-vid${playing ? " show" : ""}`}
              onLoadedData={() => { if (hovering.current) play(); }}
              onPlaying={() => setPlaying(true)}
            />
          )}
        </>
      ) : (
        <span className="lib-poster-ph">{placeholder}</span>
      )}
      {children}
    </div>
  );
}
