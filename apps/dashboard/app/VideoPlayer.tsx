"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ─── Global single-playback manager ──────────────────────────────────────
   Only ONE video plays at a time across the whole page, so a grid of clips (or
   two posts open) never decodes several heavy streams at once and hangs the tab.
   Every player registers its <video>; starting one pauses the rest. */
const registry = new Set<HTMLVideoElement>();
function claimPlayback(el: HTMLVideoElement) {
  for (const v of registry) if (v !== el && !v.paused) v.pause();
}

function isEditable(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
}

/* Seconds → "M:SS" (or "H:MM:SS"). */
function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
/* Seconds → SMPTE-ish "MM:SS:FF" timecode at the given fps. */
function tc(t: number, fps: number): string {
  const total = Math.round(t * fps);
  const f = total % fps;
  const secs = Math.floor(total / fps);
  return `${fmt(secs)}:${String(f).padStart(2, "0")}`;
}

const RATES = [0.25, 0.5, 1, 1.5, 2];

type Props = {
  src: string;
  poster?: string;
  fps?: number;
  /** play automatically once scrolled into view (muted). Pauses when off-screen. */
  autoPlay?: boolean;
  loop?: boolean;
  /** aspect ratio as width/height (e.g. 9/16); else the frame fits its box. */
  aspect?: number;
  className?: string;
};

export function VideoPlayer({ src, poster, fps = 30, autoPlay = false, loop: loopInit = false, aspect, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const v = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);

  const [ready, setReady] = useState(false); // metadata loaded
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0); // 0..1 furthest buffered ahead of cur
  const [waiting, setWaiting] = useState(false);
  const [muted, setMuted] = useState(autoPlay); // autoplay must start muted
  const [vol, setVol] = useState(1);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(loopInit);
  const [fs, setFs] = useState(false);
  const [info, setInfo] = useState(false); // tools overlay
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [activated, setActivated] = useState(autoPlay); // has the user/viewport triggered a load?
  const [showUI, setShowUI] = useState(true);
  const [rateOpen, setRateOpen] = useState(false); // custom speed dropdown
  const rateRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  /* register / unregister with the global single-play manager */
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    registry.add(el);
    return () => {
      registry.delete(el);
    };
  }, []);

  /* autoplay only WHEN visible; pause when scrolled away (saves decode + bandwidth) */
  useEffect(() => {
    const el = v.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          if (autoPlay) {
            claimPlayback(el);
            void el.play().catch(() => {});
          }
        } else if (!el.paused) {
          el.pause();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(wrap);
    return () => io.disconnect();
  }, [autoPlay]);

  const togglePlay = useCallback(() => {
    const el = v.current;
    if (!el) return;
    setActivated(true);
    if (el.paused) {
      claimPlayback(el);
      void el.play().catch(() => {});
    } else el.pause();
  }, []);

  const seek = useCallback((t: number) => {
    const el = v.current;
    if (!el || !isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(el.duration, t));
  }, []);

  const stepFrame = useCallback(
    (dir: number) => {
      const el = v.current;
      if (!el) return;
      el.pause();
      seek(el.currentTime + (dir / fps) * 1.0001);
    },
    [fps, seek],
  );

  const toggleFs = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.requestFullscreen?.().catch(() => {});
  }, []);

  const togglePip = useCallback(async () => {
    const el = v.current as any;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await (document as any).exitPictureInPicture();
      else await el.requestPictureInPicture?.();
    } catch {
      /* unsupported */
    }
  }, []);

  /* keyboard shortcuts — only while this player is hovered/focused */
  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const el = v.current;
      if (!el) return;
      const k = e.key;
      if (k === " " || k === "k") { e.preventDefault(); togglePlay(); }
      else if (k === "ArrowLeft") { e.preventDefault(); e.shiftKey ? stepFrame(-1) : seek(el.currentTime - 5); }
      else if (k === "ArrowRight") { e.preventDefault(); e.shiftKey ? stepFrame(1) : seek(el.currentTime + 5); }
      else if (k === ",") { e.preventDefault(); stepFrame(-1); }
      else if (k === ".") { e.preventDefault(); stepFrame(1); }
      else if (k === "ArrowUp") { e.preventDefault(); setVolSafe(Math.min(1, vol + 0.1)); }
      else if (k === "ArrowDown") { e.preventDefault(); setVolSafe(Math.max(0, vol - 0.1)); }
      else if (k === "m") { e.preventDefault(); toggleMute(); }
      else if (k === "f") { e.preventDefault(); toggleFs(); }
      else if (k === "j") { e.preventDefault(); seek(el.currentTime - 10); }
      else if (k === "l") { e.preventDefault(); seek(el.currentTime + 10); }
      else if (k === "i") { e.preventDefault(); setInfo((s) => !s); }
      else if (/^[0-9]$/.test(k)) { e.preventDefault(); seek((el.duration * Number(k)) / 10); }
    },
    [togglePlay, stepFrame, seek, vol, toggleFs],
  );

  function setVolSafe(nv: number) {
    const el = v.current;
    if (!el) return;
    el.volume = nv;
    el.muted = nv === 0;
    setVol(nv);
    setMuted(nv === 0);
  }
  function toggleMute() {
    const el = v.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
    if (!el.muted && el.volume === 0) setVolSafe(0.6);
  }
  function setRateSafe(r: number) {
    const el = v.current;
    if (el) el.playbackRate = r;
    setRate(r);
  }

  /* auto-hide the control bar while playing + mouse idle */
  const poke = useCallback(() => {
    setShowUI(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (v.current && !v.current.paused) setShowUI(false);
    }, 2200);
  }, []);

  /* media element events */
  function onLoaded() {
    const el = v.current!;
    setDur(el.duration);
    setDims({ w: el.videoWidth, h: el.videoHeight });
    setReady(true);
  }
  function onTime() {
    const el = v.current!;
    setCur(el.currentTime);
    if (el.buffered.length) {
      // furthest buffered end at/after the playhead
      let end = 0;
      for (let i = 0; i < el.buffered.length; i++) {
        if (el.buffered.start(i) <= el.currentTime + 0.25) end = Math.max(end, el.buffered.end(i));
      }
      setBuffered(el.duration ? end / el.duration : 0);
    }
  }

  useEffect(() => {
    const onFsChange = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  /* close the speed dropdown on outside click / Escape */
  useEffect(() => {
    if (!rateOpen) return;
    const onDown = (e: PointerEvent) => {
      if (rateRef.current && !rateRef.current.contains(e.target as Node)) setRateOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setRateOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [rateOpen]);

  /* scrub bar pointer handling (click + drag) */
  const scrubAt = useCallback(
    (clientX: number) => {
      const bar = scrubRef.current;
      const el = v.current;
      if (!bar || !el || !isFinite(el.duration)) return;
      const r = bar.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      seek(p * el.duration);
    },
    [seek],
  );
  const onScrubDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrubAt(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent) => {
    const bar = scrubRef.current;
    const el = v.current;
    if (bar && el && isFinite(el.duration)) {
      const r = bar.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      setHover({ x: p, t: p * el.duration });
    }
    if (e.buttons === 1) scrubAt(e.clientX);
  };

  const pct = dur ? (cur / dur) * 100 : 0;
  const curFrame = Math.round(cur * fps);

  return (
    <div
      ref={wrapRef}
      className={`vp${fs ? " vp-fs" : ""}${className ? " " + className : ""}`}
      style={aspect ? { aspectRatio: String(aspect) } : undefined}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerMove={poke}
      onMouseLeave={() => playing && setShowUI(false)}
    >
      <video
        ref={v}
        src={activated ? src : undefined}
        poster={poster}
        preload="metadata"
        playsInline
        muted={muted}
        loop={loop}
        className="vp-video"
        onClick={togglePlay}
        onDoubleClick={toggleFs}
        onLoadedMetadata={onLoaded}
        onTimeUpdate={onTime}
        onProgress={onTime}
        onPlay={() => { setPlaying(true); poke(); }}
        onPause={() => { setPlaying(false); setShowUI(true); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onVolumeChange={() => { const el = v.current; if (el) { setVol(el.volume); setMuted(el.muted); } }}
      />

      {/* lazy poster / first-load click target — heavy video isn't fetched until here */}
      {!activated && (
        <button className="vp-bigplay" onClick={togglePlay} aria-label="Play">
          <PlayIcon big />
        </button>
      )}
      {activated && !playing && ready && (
        <button className="vp-bigplay subtle" onClick={togglePlay} aria-label="Play">
          <PlayIcon big />
        </button>
      )}
      {waiting && activated && <div className="vp-spinner" />}

      {/* tools / info overlay */}
      {info && (
        <div className="vp-info">
          <div><span>resolution</span>{dims ? `${dims.w}×${dims.h}` : "—"}</div>
          <div><span>fps</span>{fps}</div>
          <div><span>frame</span>{curFrame} / {Math.round(dur * fps)}</div>
          <div><span>timecode</span>{tc(cur, fps)}</div>
          <div><span>rate</span>{rate}×</div>
        </div>
      )}

      {/* control bar */}
      <div className={`vp-bar${showUI || !playing || rateOpen ? " show" : ""}`}>
        <div
          ref={scrubRef}
          className="vp-scrub"
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerLeave={() => setHover(null)}
        >
          <div className="vp-scrub-buf" style={{ width: `${buffered * 100}%` }} />
          <div className="vp-scrub-played" style={{ width: `${pct}%` }} />
          <div className="vp-scrub-head" style={{ left: `${pct}%` }} />
          {hover && (
            <div className="vp-scrub-tip" style={{ left: `${hover.x * 100}%` }}>
              {tc(hover.t, fps)}
            </div>
          )}
        </div>
        <div className="vp-ctrls">
          <button className="vp-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="vp-btn" onClick={() => stepFrame(-1)} aria-label="Previous frame" title="Previous frame ( , )"><PrevFrameIcon /></button>
          <button className="vp-btn" onClick={() => stepFrame(1)} aria-label="Next frame" title="Next frame ( . )"><NextFrameIcon /></button>
          <div className="vp-vol">
            <button className="vp-btn" onClick={toggleMute} aria-label="Mute">
              {muted || vol === 0 ? <MuteIcon /> : <VolIcon />}
            </button>
            <input
              className="vp-vol-range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : vol}
              onChange={(e) => setVolSafe(Number(e.target.value))}
            />
          </div>
          <div className="vp-time">
            <span className="vp-time-cur">{fmt(cur)}</span>
            <span className="vp-time-sep">/</span>
            <span className="vp-time-dur">{fmt(dur)}</span>
          </div>
          <div className="vp-spacer" />
          <div className="vp-rate" ref={rateRef}>
            <button
              className={`vp-rate-btn${rateOpen ? " open" : ""}`}
              onClick={() => setRateOpen((s) => !s)}
              aria-haspopup="listbox"
              aria-expanded={rateOpen}
              title="Playback speed"
            >
              <span className="vp-rate-val">{rate}×</span>
              <ChevronIcon />
            </button>
            {rateOpen && (
              <div className="vp-rate-menu" role="listbox" aria-label="Playback speed">
                {RATES.map((r) => (
                  <button
                    key={r}
                    role="option"
                    aria-selected={r === rate}
                    className={`vp-rate-opt${r === rate ? " sel" : ""}`}
                    onClick={() => { setRateSafe(r); setRateOpen(false); }}
                  >
                    {r === rate && <CheckIcon />}
                    <span>{r === 1 ? "Normal" : `${r}×`}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className={`vp-btn${loop ? " on" : ""}`} onClick={() => { const el = v.current; if (el) el.loop = !el.loop; setLoop((s) => !s); }} title="Loop">
            <LoopIcon />
          </button>
          <button className={`vp-btn${info ? " on" : ""}`} onClick={() => setInfo((s) => !s)} title="Info / tools ( i )">
            <InfoIcon />
          </button>
          <button className="vp-btn" onClick={togglePip} title="Picture in picture">
            <PipIcon />
          </button>
          <button className="vp-btn" onClick={toggleFs} title="Fullscreen ( f )">
            {fs ? <FsExitIcon /> : <FsIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── inline icons (no dependency) ─────────────────────────────────────────── */
const S = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "currentColor" } as const;
const PlayIcon = ({ big }: { big?: boolean }) => (
  <svg {...S} width={big ? 30 : 16} height={big ? 30 : 16}><path d="M8 5v14l11-7z" /></svg>
);
const PauseIcon = () => <svg {...S}><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>;
const PrevFrameIcon = () => <svg {...S}><path d="M7 6h2v12H7zm11 0v12l-8-6z" /></svg>;
const NextFrameIcon = () => <svg {...S}><path d="M15 6h2v12h-2zM6 6v12l8-6z" /></svg>;
const ChevronIcon = () => <svg {...S} width={12} height={12}><path d="M7 10l5 5 5-5z" /></svg>;
const CheckIcon = () => <svg {...S} width={13} height={13}><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>;
const VolIcon = () => <svg {...S}><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" /></svg>;
const MuteIcon = () => <svg {...S}><path d="M3 9v6h4l5 5V4L7 9H3zm16.6 3l2-2-1.4-1.4-2 2-2-2L14.8 10l2 2-2 2 1.4 1.4 2-2 2 2 1.4-1.4-2-2z" /></svg>;
const LoopIcon = () => <svg {...S}><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" /></svg>;
const InfoIcon = () => <svg {...S}><path d="M11 9h2V7h-2m1 13a8 8 0 110-16 8 8 0 010 16m-1-4h2v-6h-2z" /></svg>;
const PipIcon = () => <svg {...S}><path d="M19 11h-8v6h8v-6zm4 8V5a2 2 0 00-2-2H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2zm-2 .02H3V4.98h18v14.04z" /></svg>;
const FsIcon = () => <svg {...S}><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>;
const FsExitIcon = () => <svg {...S}><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg>;
