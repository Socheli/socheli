#!/usr/bin/env python3
"""Offline vector-asset backend for the Motion Graphics mood (OPTIONAL).

Generates EDITABLE vector assets — SVG (OmniSVG) or Lottie JSON (OmniLottie) —
from a text prompt, for the mograph asset cache (see mograph-assets.ts). These
are GPU models, so this runs OFFLINE as a cache-fill step, never in the per-frame
render loop.

Usage:  omnisvg.py <svg|lottie> "<prompt>" <out_path>
Exit 0 + file written on success; non-zero otherwise (caller falls back to
native scene graphics — nothing breaks).

This is a STUB / integration point. Wire a real backend by implementing
generate_svg() / generate_lottie() against one of:
  - OmniSVG    https://github.com/OmniSVG/OmniSVG      (open weights, text/img -> SVG)
  - OmniLottie https://github.com/OpenVGLab/OmniLottie (Apache-2.0, text/img/video -> Lottie)
or a hosted endpoint wrapper. Until then it exits non-zero so the pipeline
cleanly uses the device_mockup / bento native shapes.
"""
import sys


def generate_svg(prompt: str, out_path: str) -> bool:
    # TODO: load OmniSVG (Qwen2.5-VL + SVG tokenizer) and write an <svg> to out_path.
    return False


def generate_lottie(prompt: str, out_path: str) -> bool:
    # TODO: load OmniLottie (~4B, ~15GB VRAM) and write Lottie JSON to out_path.
    return False


def main() -> int:
    if len(sys.argv) < 4:
        sys.stderr.write('usage: omnisvg.py <svg|lottie> "<prompt>" <out_path>\n')
        return 2
    kind, prompt, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        ok = generate_lottie(prompt, out_path) if kind == "lottie" else generate_svg(prompt, out_path)
    except Exception as e:  # noqa: BLE001 — fail open, never crash the render
        sys.stderr.write(f"mograph asset backend error: {e}\n")
        return 1
    if not ok:
        sys.stderr.write("mograph asset backend not installed (stub) — falling back to native graphics\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
