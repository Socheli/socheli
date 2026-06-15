#!/usr/bin/env python3
"""Word-level timestamps from an audio file via the cached MLX Whisper turbo model.
Usage: whisper-words.py <audio> [--prompt "<vocabulary hint>"] > words.json
Prints: {"words":[{"word","start","end"}],
         "segments":[{"index","start","end","text","avg_logprob","no_speech_prob"}],
         "text": "..."}

--prompt (a.k.a. Whisper `initial_prompt`): a short free-text hint listing proper
nouns / domain terms / names that appear in the audio (e.g. "Ada Lovelace,
CognitiveX, Laravel, PHP"). Whisper conditions the decoder on it, which sharply
improves recognition of names and jargon it would otherwise mishear ("Ada
Lovejoy"). Timings are unaffected — only token choice is biased.

WHY segments[] (Pillar 5 / Ingest §7.1.2 N2a): the karaoke caption path only needs
the flattened `words`, but deep understanding of an INGESTED video needs the
segment boundaries Whisper already produces — each segment is a spoken line/phrase
with its own confidence (avg_logprob) and speech/no-speech probability. The
shot-boundary fusion (speaker turns), redundancy detection (near-duplicate lines),
and the editorial scorers all key off these line-level spans, which the old
word-only flatten discarded. `words` stays byte-identical so the existing caller
(editor-tools.transcribeVideoAudio / media.whisperWords) is unaffected — segments
is purely additive.
"""
import sys, json, math

def _finite(x):
    """True only for a real, finite float — Whisper occasionally yields NaN/inf for
    avg_logprob/no_speech_prob, and json.dumps would then emit bare `NaN`/`Infinity`
    tokens that JS's JSON.parse rejects (the whole transcript fails to load). Guard
    every float we serialize through this."""
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False

def main() -> int:
    args = sys.argv[1:]
    if not args:
        print("usage: whisper-words.py <audio> [--prompt \"<vocabulary hint>\"]", file=sys.stderr)
        return 2
    audio = next((a for a in args if not a.startswith("--")), None)
    if not audio:
        print("usage: whisper-words.py <audio> [--prompt \"<vocabulary hint>\"]", file=sys.stderr)
        return 2
    # --prompt "<hint>"  (biases the decoder toward known names/jargon)
    prompt = None
    if "--prompt" in args:
        i = args.index("--prompt")
        if i + 1 < len(args):
            prompt = args[i + 1]
    import mlx_whisper
    kwargs = dict(path_or_hf_repo="mlx-community/whisper-large-v3-turbo", word_timestamps=True)
    if prompt:
        kwargs["initial_prompt"] = prompt
    r = mlx_whisper.transcribe(audio, **kwargs)
    words = []
    segments = []
    for i, seg in enumerate(r.get("segments", [])):
        for w in seg.get("words", []):
            t = w.get("word", "").strip()
            if t and _finite(w.get("start")) and _finite(w.get("end")):
                words.append({"word": t, "start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3)})
        # The segment line itself — boundaries + Whisper's own quality signals. Fail
        # open per-field: a model build that omits avg_logprob/no_speech_prob simply
        # leaves that key out rather than aborting the whole transcript.
        text = (seg.get("text") or "").strip()
        if text and seg.get("start") is not None and seg.get("end") is not None:
            entry = {
                "index": i,
                "start": round(float(seg["start"]), 3),
                "end": round(float(seg["end"]), 3),
                "text": text,
            }
            if _finite(seg.get("avg_logprob")):
                entry["avg_logprob"] = round(float(seg["avg_logprob"]), 4)
            if _finite(seg.get("no_speech_prob")):
                entry["no_speech_prob"] = round(float(seg["no_speech_prob"]), 4)
            segments.append(entry)
    # allow_nan=False: refuse to emit non-strict JSON tokens — if anything slips
    # through the per-field guards above, fail loudly here rather than write garbage.
    print(json.dumps({"words": words, "segments": segments, "text": r.get("text", "").strip()}, allow_nan=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
