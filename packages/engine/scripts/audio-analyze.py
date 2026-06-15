#!/usr/bin/env python3
"""Characterize a reference track's musical feel for style-matching.
Usage: audio-analyze.py <audio> > features.json
Outputs tempo (BPM), energy, brightness, tonality + a suggested MusicGen prompt.
Reference-only: caller deletes the audio after analysis.
"""
import sys, json, subprocess, tempfile, os

def main() -> int:
    if len(sys.argv) < 2:
        print("usage: audio-analyze.py <audio>", file=sys.stderr)
        return 2
    src = sys.argv[1]
    import numpy as np
    from scipy.io import wavfile

    wav = tempfile.mktemp(suffix=".wav")
    subprocess.run(["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", "22050", wav],
                   capture_output=True)
    sr, x = wavfile.read(wav)
    os.remove(wav)
    x = x.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x /= (np.max(np.abs(x)) + 1e-9)

    # STFT
    frame, hop = 2048, 512
    win = np.hanning(frame)
    frames = [x[i:i+frame]*win for i in range(0, len(x)-frame, hop)]
    mags = np.array([np.abs(np.fft.rfft(f)) for f in frames]) + 1e-9
    freqs = np.fft.rfftfreq(frame, 1/sr)

    # brightness = spectral centroid
    centroid = float(np.mean(np.sum(mags*freqs, axis=1) / np.sum(mags, axis=1)))
    # energy
    rms = float(np.sqrt(np.mean(x**2)))
    # tonality = 1 - mean spectral flatness
    gm = np.exp(np.mean(np.log(mags), axis=1)); am = np.mean(mags, axis=1)
    tonality = float(1 - np.mean(gm/am))

    # tempo via onset-flux autocorrelation
    flux = np.sqrt(np.sum(np.maximum(0, np.diff(mags, axis=0))**2, axis=1))
    flux -= flux.mean()
    ac = np.correlate(flux, flux, mode="full")[len(flux)-1:]
    fps = sr/hop
    lo, hi = int(fps*60/180), int(fps*60/60)  # 60-180 BPM
    seg = ac[lo:hi]
    bpm = float(60*fps/(lo+int(np.argmax(seg)))) if len(seg) else 0.0

    feel = ("driving" if rms > 0.18 else "gentle")
    bright = ("bright" if centroid > 2500 else "warm" if centroid > 1200 else "dark")
    prompt = f"{bright} {feel} instrumental, {'melodic electronic with a clear beat' if bpm>90 else 'cinematic ambient with soft pulse'}, no vocals"
    print(json.dumps({
        "bpm": round(bpm, 1), "energy": round(rms, 3),
        "brightness_hz": round(centroid), "tonality": round(tonality, 3),
        "feel": feel, "bright": bright, "suggested_prompt": prompt,
    }))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
