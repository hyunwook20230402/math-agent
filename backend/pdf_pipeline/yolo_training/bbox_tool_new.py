"""bbox 좌표 측정 도구 — 수능 가형+나형 2018~2021 (96장)

사용법:
  cd backend/pdf_pipeline/yolo_training
  python bbox_tool_new.py

조작:
  - 왼쪽 클릭 2번: bbox 지정 (1클릭=좌상단, 2클릭=우하단)
  - u: 마지막 박스 취소
  - n / Enter / Space: 다음 이미지 (현재 페이지 저장 후 이동)
  - b: 이전 이미지로 돌아가기
  - q: 종료 + 전체 결과를 labels_new.py로 저장
"""
import cv2
import numpy as np
from pathlib import Path

IMAGES_DIR = Path("dataset_new/images/train")
LABELS_DIR = Path("dataset_new/labels/train")
SCALE = 0.35  # 표시 비율

ALL_PAGES = (
    [f"2018_ga_page_{i:02d}" for i in range(1, 13)] +
    [f"2019_ga_page_{i:02d}" for i in range(1, 13)] +
    [f"2020_ga_page_{i:02d}" for i in range(1, 13)] +
    [f"2021_ga_page_{i:02d}" for i in range(1, 13)] +
    [f"2018_na_page_{i:02d}" for i in range(1, 13)] +
    [f"2019_na_page_{i:02d}" for i in range(1, 13)] +
    [f"2020_na_page_{i:02d}" for i in range(1, 13)] +
    [f"2021_na_page_{i:02d}" for i in range(1, 13)]
)

W, H = 3509, 4963

state = {
    "boxes": [],
    "clicks": [],
    "num": 1,
    "dirty": False,
}
all_results = {}
img_orig = None


def scale_to_orig(x, y):
    return int(round(x / SCALE)), int(round(y / SCALE))


def render():
    out = cv2.resize(img_orig, None, fx=SCALE, fy=SCALE)
    for num, x1, y1, x2, y2 in state["boxes"]:
        sx1, sy1 = int(x1 * SCALE), int(y1 * SCALE)
        sx2, sy2 = int(x2 * SCALE), int(y2 * SCALE)
        cv2.rectangle(out, (sx1, sy1), (sx2, sy2), (0, 0, 255), 2)
        cv2.putText(out, str(num), (sx1 + 4, sy1 + 26),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 0, 255), 2)
    if len(state["clicks"]) == 1:
        cv2.circle(out, state["clicks"][0], 6, (0, 255, 0), -1)
    return out


def mouse_cb(event, x, y, flags, param):
    if event != cv2.EVENT_LBUTTONDOWN:
        return
    state["clicks"].append((x, y))
    if len(state["clicks"]) == 2:
        (sx1, sy1), (sx2, sy2) = state["clicks"]
        sx1, sx2 = min(sx1, sx2), max(sx1, sx2)
        sy1, sy2 = min(sy1, sy2), max(sy1, sy2)
        ox1, oy1 = scale_to_orig(sx1, sy1)
        ox2, oy2 = scale_to_orig(sx2, sy2)
        num = state["num"]
        state["boxes"].append((num, ox1, oy1, ox2, oy2))
        state["num"] += 1
        state["clicks"] = []
        state["dirty"] = True
        print(f"  [{num}번] ({ox1},{oy1}) → ({ox2},{oy2})")
    cv2.imshow("bbox_tool_new", render())


def save_yolo(page_name, boxes):
    LABELS_DIR.mkdir(parents=True, exist_ok=True)
    lines = []
    for _, x1, y1, x2, y2 in boxes:
        cx = ((x1 + x2) / 2) / W
        cy = ((y1 + y2) / 2) / H
        w  = (x2 - x1) / W
        h  = (y2 - y1) / H
        lines.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    path = LABELS_DIR / f"{page_name}.txt"
    path.write_text("\n".join(lines))


def save_output():
    lines = ["# 자동 생성된 라벨 좌표 (수능 나형 2018~2021)\nPAGE_LABELS = {\n"]
    for pname, blist in all_results.items():
        lines.append(f'  "{pname}": [\n')
        for num, x1, y1, x2, y2 in blist:
            lines.append(f'    ({num}, {x1}, {y1}, {x2}, {y2}),\n')
        lines.append('  ],\n')
    lines.append("}\n")
    Path("labels_new.py").write_text("".join(lines), encoding="utf-8")
    print("\n[저장] labels_new.py 저장 완료")


def main():
    global img_orig

    cv2.namedWindow("bbox_tool_new", cv2.WINDOW_NORMAL)
    cv2.setMouseCallback("bbox_tool_new", mouse_cb)

    idx = 0
    total = len(ALL_PAGES)

    while idx < total:
        page_name = ALL_PAGES[idx]
        img_path = IMAGES_DIR / f"{page_name}.png"

        if not img_path.exists():
            print(f"[SKIP] {page_name} 이미지 없음")
            idx += 1
            continue

        state["boxes"] = list(all_results.get(page_name, []))
        state["clicks"] = []
        state["num"] = len(state["boxes"]) + 1
        state["dirty"] = False

        img_orig = cv2.imread(str(img_path))
        h_disp = int(img_orig.shape[0] * SCALE)
        w_disp = int(img_orig.shape[1] * SCALE)
        cv2.resizeWindow("bbox_tool_new", w_disp, h_disp)

        print(f"\n[{idx+1}/{total}] {page_name}  (박스 {len(state['boxes'])}개 로드)")
        cv2.setWindowTitle("bbox_tool_new",
            f"[{idx+1}/{total}] {page_name}  |  u=취소  n/Enter=다음  b=이전  q=종료")

        action = None
        while action is None:
            cv2.imshow("bbox_tool_new", render())
            key = cv2.waitKey(20) & 0xFF
            if key in (ord('n'), ord(' '), 13):
                action = 'next'
            elif key == ord('b'):
                action = 'prev'
            elif key == ord('q'):
                action = 'quit'
            elif key == ord('u'):
                if state["boxes"]:
                    removed = state["boxes"].pop()
                    state["num"] -= 1
                    state["clicks"] = []
                    print(f"  [취소] {removed[0]}번 박스 삭제")
                    cv2.imshow("bbox_tool_new", render())

        if state["boxes"]:
            all_results[page_name] = list(state["boxes"])
            save_yolo(page_name, state["boxes"])
            print(f"  → {len(state['boxes'])}개 저장")

        if action == 'next':
            idx += 1
        elif action == 'prev':
            idx = max(0, idx - 1)
        elif action == 'quit':
            break

    cv2.destroyAllWindows()
    save_output()
    print(f"\n완료! 총 {len(all_results)}개 페이지 라벨링됨")
    print("YOLO 라벨: dataset_new/labels/train/")
    print("좌표 백업: labels_new.py")


if __name__ == "__main__":
    main()
