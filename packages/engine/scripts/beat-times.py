#!/usr/bin/env python3
"""Beat times (seconds) from an audio file, for beat-synced motion.
Usage: beat-times.py <audio> > {"bpm":..,"beats":[..]}
Pure numpy/scipy (onset-flux tempo + phase). No heavy deps.
"""
import sys, json, subprocess, tempfile, os

def main() -> int:
    if len(sys.argv) < 2:
        print("usage: beat-times.py <audio>", file=sys.stderr); return 2
    import numpy as np
    from scipy.io import wavfile
    wav = tempfile.mktemp(suffix=".wav")
    subprocess.run(["ffmpeg", "-y", "-i", sys.argv[1], "-ac", "1", "-ar", "22050", wav], capture_output=True)
    sr, x = wavfile.read(wav); os.remove(wav)
    x = x.astype(np.float64)
    if x.ndim > 1: x = x.mean(axis=1)
    x /= (np.max(np.abs(x)) + 1e-9)

    frame, hop = 1024, 512
    win = np.hanning(frame)
    mags = np.array([np.abs(np.fft.rfft(x[i:i+frame]*win)) for i in range(0, len(x)-frame, hop)]) + 1e-9
    flux = np.sqrt(np.sum(np.maximum(0, np.diff(mags, axis=0))**2, axis=1))
    flux = flux - flux.mean()
    fps = sr / hop

    ac = np.correlate(flux, flux, mode="full")[len(flux)-1:]
    lo, hi = int(fps*60/175), int(fps*60/70)  # 70-175 BPM
    seg = ac[lo:hi]
    if len(seg) == 0:
        print(json.dumps({"bpm": 0, "beats": []})); return 0
    period = lo + int(np.argmax(seg))          # frames per beat
    bpm = 60 * fps / period
    # phase: align a beat pulse train to maximize energy
    best_off, best_e = 0, -1
    for off in range(period):
        e = flux[off::period].sum()
        if e > best_e: best_e, best_off = e, off
    beats = []
    t = best_off
    n = len(flux)
    while t < n:
        beats.append(round(t / fps, 3))
        t += period
    print(json.dumps({"bpm": round(bpm, 1), "beats": beats}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
