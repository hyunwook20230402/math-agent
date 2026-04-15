"""labels_output.py(bbox_tool 직접 찍은 좌표) → YOLO 라벨 파일로 변환

기존 dataset/labels/train/*.txt 전부 덮어씀.
"""
from pathlib import Path
from labels_output import PAGE_LABELS

W, H = 3509, 4963
LABELS_DIR = Path("dataset/labels/train")
LABELS_DIR.mkdir(parents=True, exist_ok=True)

total = 0
for page_name, boxes in PAGE_LABELS.items():
    lines = []
    for _, x1, y1, x2, y2 in boxes:
        cx = ((x1 + x2) / 2) / W
        cy = ((y1 + y2) / 2) / H
        w  = (x2 - x1) / W
        h  = (y2 - y1) / H
        lines.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    path = LABELS_DIR / f"{page_name}.txt"
    path.write_text("\n".join(lines))
    print(f"[{page_name}] {len(lines)}개")
    total += len(lines)

print(f"\n완료! 총 {total}개 라벨 → {LABELS_DIR.absolute()}/")
