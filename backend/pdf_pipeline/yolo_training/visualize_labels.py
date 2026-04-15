"""labels_output.py 좌표로 빨간 박스 디버그 이미지 생성"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from labels_output import PAGE_LABELS

IMAGES_DIR = Path("dataset/images/train")
OUT_DIR = Path("debug_user_labels")
SCALE = 1/3

OUT_DIR.mkdir(exist_ok=True)

for page_name, boxes in PAGE_LABELS.items():
    img_path = IMAGES_DIR / f"{page_name}.png"
    if not img_path.exists():
        print(f"[SKIP] {img_path} 없음")
        continue

    img = Image.open(img_path)
    draw = ImageDraw.Draw(img)

    for num, x1, y1, x2, y2 in boxes:
        draw.rectangle([x1, y1, x2, y2], outline="red", width=8)
        draw.text((x1 + 10, y1 + 10), str(num), fill="red")

    w, h = img.size
    img = img.resize((int(w * SCALE), int(h * SCALE)), Image.LANCZOS)
    out_path = OUT_DIR / f"{page_name}_debug.png"
    img.save(out_path)
    nums = [b[0] for b in boxes]
    print(f"[{page_name}] {len(boxes)}개 박스 → {nums}")

print(f"\n완료! {OUT_DIR.absolute()}/")
