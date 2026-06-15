#!/usr/bin/env python3
"""Fast local image gen for abstract B-roll via stabilityai/sd-turbo (MPS).
Usage: sdturbo.py "<prompt>" <width> <height> <out.png>
Heavily-graded behind text, so speed > fidelity. Exits non-zero if stack missing.
"""
import sys

def main() -> int:
    if len(sys.argv) < 5:
        print("usage: sdturbo.py <prompt> <w> <h> <out>", file=sys.stderr)
        return 2
    prompt, w, h, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    try:
        import torch
        from diffusers import AutoPipelineForText2Image
    except Exception as e:  # noqa: BLE001
        print(f"diffusers stack unavailable: {e}", file=sys.stderr)
        return 1

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    style = ", cinematic still, moody, dark, dramatic lighting, depth of field, film grain, atmospheric, no text"
    try:
        pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo", torch_dtype=torch.float16)
        pipe = pipe.to(device)
        img = pipe(prompt=prompt + style, num_inference_steps=3, guidance_scale=0.0, height=h, width=w).images[0]
    except Exception:  # fp16 can be flaky on MPS VAE → retry fp32
        pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo", torch_dtype=torch.float32).to(device)
        img = pipe(prompt=prompt + style, num_inference_steps=3, guidance_scale=0.0, height=h, width=w).images[0]
    img.save(out)
    print(f"wrote {out} ({w}x{h} on {device})")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
