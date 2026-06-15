#!/usr/bin/env python3
"""Local music bed via MusicGen (model from $MUSICGEN_MODEL, cached in HF hub).
Usage: musicgen.py "<prompt>" <duration_sec> <out.wav> [seed] [guidance] [temperature]
Generates N candidates and keeps the most MUSICAL one (lowest spectral flatness =
more tonal/structured, less noise/static). Exits non-zero if the stack is missing.

Env:
  MUSICGEN_MODEL  HF model id (default facebook/musicgen-medium; small/large/melody ok)
  HF_HOME / HF_HUB_CACHE  cache home (set by media.ts to data/hf-cache); the caller
  also sets HF_HUB_OFFLINE=1 so this NEVER downloads — the model must already be
  cached (run warm-musicgen.sh once). transformers reads these from the environment.
"""
import os
import sys

def main() -> int:
    if len(sys.argv) < 4:
        print("usage: musicgen.py <prompt> <seconds> <out.wav> [seed] [guidance] [temp]", file=sys.stderr)
        return 2
    prompt, seconds, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    guidance = float(sys.argv[5]) if len(sys.argv) > 5 else 3.5
    temp = float(sys.argv[6]) if len(sys.argv) > 6 else 0.95
    try:
        import numpy as np
        import torch
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
        import scipy.io.wavfile
    except Exception as e:  # noqa: BLE001
        print(f"musicgen stack unavailable: {e}", file=sys.stderr)
        return 1

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model_id = os.environ.get("MUSICGEN_MODEL", "facebook/musicgen-medium")
    proc = AutoProcessor.from_pretrained(model_id)
    model = MusicgenForConditionalGeneration.from_pretrained(model_id).to(device)
    inputs = proc(text=[prompt], padding=True, return_tensors="pt").to(device)
    max_new = min(1503, int(seconds * 50))
    sr = model.config.audio_encoder.sampling_rate

    def musicality(wav: "np.ndarray") -> float:
        # higher = more musical. Use 1 - mean spectral flatness (tonal vs noisy).
        w = wav.astype(np.float64)
        if w.size < 2048:
            return 0.0
        frame = 2048
        hop = 1024
        flats = []
        win = np.hanning(frame)
        for i in range(0, len(w) - frame, hop):
            seg = w[i : i + frame] * win
            mag = np.abs(np.fft.rfft(seg)) + 1e-9
            gm = np.exp(np.mean(np.log(mag)))
            am = np.mean(mag)
            flats.append(gm / am)  # 0=tonal, 1=noise
        return 1.0 - float(np.mean(flats)) if flats else 0.0

    candidates = 1  # 2+ OOMs on the M4 alongside the other models → drops to the drone fallback
    best = None
    best_score = -1.0
    for c in range(candidates):
        torch.manual_seed(seed + c * 1000 + 1)
        with torch.no_grad():
            audio = model.generate(
                **inputs, max_new_tokens=max_new, do_sample=True,
                guidance_scale=guidance, temperature=temp,
            )
        wav = audio[0, 0].cpu().numpy()
        score = musicality(wav)
        print(f"candidate {c}: musicality={score:.3f}")
        if score > best_score:
            best_score, best = score, wav

    scipy.io.wavfile.write(out, rate=sr, data=best)
    print(f"wrote {out} ({len(best)/sr:.1f}s @ {sr}Hz on {device}, musicality={best_score:.3f})")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
