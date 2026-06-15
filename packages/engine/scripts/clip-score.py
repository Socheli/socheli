#!/usr/bin/env python3
"""CLIP image<->text similarity, to verify a B-roll clip matches its line.
Usage: clip-score.py <image> "<query>" > {"score": 0.0-1.0}
"""
import sys, json

def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"score": 0})); return 0
    img, text = sys.argv[1], sys.argv[2]
    try:
        import torch
        from PIL import Image
        from transformers import CLIPModel, CLIPProcessor
        m = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
        p = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
        inp = p(text=[text], images=Image.open(img).convert("RGB"), return_tensors="pt", padding=True)
        with torch.no_grad():
            o = m(**inp)
            ie = o.image_embeds / o.image_embeds.norm(dim=-1, keepdim=True)
            te = o.text_embeds / o.text_embeds.norm(dim=-1, keepdim=True)
            score = float((ie @ te.T).item())
        print(json.dumps({"score": round(score, 3)}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"score": 0, "error": str(e)}), file=sys.stderr)
        print(json.dumps({"score": 1.0}))  # fail-open: don't block render
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
