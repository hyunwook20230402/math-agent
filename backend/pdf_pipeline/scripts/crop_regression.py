"""크롭 알고리즘이 **더 나빠지지 않았는지** 기계로 검사한다.

왜 필요한가:
  크롭은 "좋아 보인다" 로는 검증이 안 된다. 한 판형을 고치면 다른 판형이 조용히 나빠진다.
  다행히 교사가 CMS 편집기에서 검수한 결과가 있으므로, 그게 정답이다.
  `tests/fixtures/ssen_user_boxes.json` 에 그 120개를 고정해 두고 매번 대조한다.

  ⚠️ 120개가 전부 정답은 아니다. 교사는 **거슬리는 것만** 고쳤으므로,
  `corrected_by_user=false` 인 57개는 알고리즘 원본이 그대로 남은 것이다.
  그걸 정답으로 채점하면 "옛 버그를 그대로 재현해야 만점" 이 되어버린다.
  그래서 두 집합을 갈라서 본다:
    [A] 수정분 63개  — 진짜 정답. 여기에 가까워져야 한다.
    [B] 미수정 57개  — 암묵 합격. 크게 움직이면 사람이 눈으로 확인해야 한다(자동 실패는 아님).

  그리고 수치보다 중요한 것이 하나 더 있다 — **글자가 잘려나갔는가**.
  박스가 좀 넓은 건 사람이 줄이면 그만이지만, 잘린 문제는 못 쓴다.

사용법:
    python -m scripts.crop_regression                 # 현재 코드 채점
    python -m scripts.crop_regression --save out.json # 결과 저장(전/후 비교용)
    python -m scripts.crop_regression --compare a.json b.json   # 두 결과 비교
"""
import argparse
import json
import sys
from pathlib import Path

import fitz
import numpy as np
from PIL import Image as PILImage

FIXTURE = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "ssen_user_boxes.json"

# 합격 기준 — 하나라도 어기면 반영하지 않는다.
MAX_WORSE_PX = 20        # 정답 대비 이만큼 넘게 멀어진 박스가 있으면 실패
MIN_IMPROVE_RATIO = 5.0  # 개선 수가 악화 수의 이 배는 되어야 한다
# '글자급' 잉크 판정 — 이보다 작으면 얇은 괘선·얼룩이라 손실로 치지 않는다.
LOST_MIN_COLUMNS = 6
LOST_MIN_PIXELS = 60


def _err(a: dict, b: dict) -> float:
    """두 박스의 네 변 중 가장 큰 차이(px)."""
    return max(abs(a[k] - b[k]) for k in ("x1", "y1", "x2", "y2"))


def compute_boxes(pdf_path: str) -> list:
    """현재 코드로 이 PDF 를 크롭했을 때 나오는 박스들 (300dpi 픽셀)."""
    from pipeline.file_converter import extract_images_from_pdf
    from pipeline.ocr_anchor_provider import (
        collect_color_labels, resolve_label_anchors, tighten_by_ink,
    )
    from pipeline.text_anchor_segmenter import find_anchors, segment_problems
    from pipeline.solution_masker import strip_solutions

    pdf = Path(pdf_path)
    rendered = {pi["page"]: pi
                for pi in extract_images_from_pdf(str(pdf), str(pdf.parent / "images"), dpi=300)}
    doc = fitz.open(str(pdf))

    anchors = find_anchors(doc)
    grays = None
    if not anchors:
        labels, cuts, grays = [], [], {}
        for pno in range(doc.page_count):
            page = doc[pno]
            pix = page.get_pixmap(matrix=fitz.Matrix(200 / 72, 200 / 72))
            rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, pix.n)[:, :, :3]
            grays[pno] = np.dot(rgb[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)
            pl, pc = collect_color_labels(pno, rgb, page.rect.width, page.rect.height)
            labels += pl
            cuts += pc
        resolved = resolve_label_anchors(labels)
        if not resolved:
            raise SystemExit("앵커를 찾지 못했습니다.")
        anchors = {"font": "ocr", "size": 12.0,
                   "columns": sorted({round(a["col_x0"], 1) for a in resolved}),
                   "anchors": resolved, "cuts": cuts}

    regions = segment_problems(doc, anchors)
    strip_solutions(doc, regions)
    if grays is not None:
        for r in regions:
            pg = doc[r["page"]]
            r["rect"] = tighten_by_ink(grays[r["page"]], r["rect"], pg.rect.width, pg.rect.height)
    regions.sort(key=lambda r: (r["page"], r["column"], r["anchor_y"]))

    out = []
    for i, r in enumerate(regions, start=1):
        pnum = r["page"] + 1
        pi = rendered.get(pnum)
        if pi is None:
            continue
        with PILImage.open(pi["image_path"]) as img:
            pw, ph = img.size
        rect = doc[r["page"]].rect
        sx, sy = pw / rect.width, ph / rect.height
        out.append({
            "number": i, "page": pnum, "anchor": r["anchor_text"],
            "x1": max(0, int(r["rect"].x0 * sx)), "y1": max(0, int(r["rect"].y0 * sy)),
            "x2": min(pw, int(r["rect"].x1 * sx)), "y2": min(ph, int(r["rect"].y1 * sy)),
        })
    return out


def lost_content(pdf_path: str, fixture_boxes: list, new_by_num: dict) -> list:
    """교사 박스 안에 있던 '글자급' 잉크가 새 박스 밖으로 나간 곳.

    박스가 넓은 건 사람이 줄이면 되지만 잘린 문제는 못 쓴다 — 이게 진짜 실패 조건이다.
    """
    from pipeline.ocr_anchor_provider import _INK_THRESHOLD

    doc = fitz.open(pdf_path)
    grays: dict = {}
    lost = []
    for fb in fixture_boxes:
        nb = new_by_num.get(fb["number"])
        if nb is None:
            continue
        p = fb["page"] - 1
        if p not in grays:
            pix = doc[p].get_pixmap(matrix=fitz.Matrix(200 / 72, 200 / 72))
            rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, pix.n)[:, :, :3]
            grays[p] = np.dot(rgb[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)
        gr = grays[p]
        s = gr.shape[1] / 2480.0
        u = fb["user_bbox"]
        ux1, uy1, ux2, uy2 = (int(u["x1"] * s), int(u["y1"] * s),
                              int(u["x2"] * s), int(u["y2"] * s))
        if uy2 - uy1 < 5:
            continue
        mask = np.zeros(gr.shape, bool)
        mask[uy1:uy2, ux1:ux2] = True
        mask[max(0, int(nb["y1"] * s)):int(nb["y2"] * s),
             max(0, int(nb["x1"] * s)):int(nb["x2"] * s)] = False
        ink = (gr < _INK_THRESHOLD) & mask
        ncols = int((ink.sum(axis=0) > 0).sum())
        npx = int(ink.sum())
        if ncols > LOST_MIN_COLUMNS and npx > LOST_MIN_PIXELS:
            lost.append({"number": fb["number"], "page": fb["page"],
                         "anchor": fb["anchor"], "columns": ncols, "pixels": npx})
    return lost


def report(fx: dict, new: list) -> dict:
    new_by_num = {b["number"]: b for b in new}
    boxes = fx["boxes"]
    result = {"total_expected": fx["total"], "total_got": len(new)}

    if len(new) != fx["total"]:
        print(f"⚠ 박스 개수가 다릅니다: {len(new)} (기대 {fx['total']}) — 아래 채점은 참고만")

    rows = []
    for fb in boxes:
        nb = new_by_num.get(fb["number"])
        if nb is None:
            continue
        rows.append({
            "number": fb["number"], "page": fb["page"], "anchor": fb["anchor"],
            "corrected": fb["corrected_by_user"],
            "base_err": _err(fb["user_bbox"], fb["baseline_bbox"]),
            "new_err": _err(fb["user_bbox"], nb),
            "moved": _err(fb["baseline_bbox"], nb),
        })

    cor = [r for r in rows if r["corrected"]]
    unt = [r for r in rows if not r["corrected"]]
    imp = [r for r in cor if r["new_err"] < r["base_err"] - 2]
    wor = [r for r in cor if r["new_err"] > r["base_err"] + 2]
    bad = [r for r in wor if r["new_err"] > r["base_err"] + MAX_WORSE_PX]

    def med(v):
        v = sorted(v)
        return v[len(v) // 2] if v else 0

    print(f"\n[A] 교사 수정분 {len(cor)}개 — 진짜 정답")
    print(f"    중앙 오차 {med([r['base_err'] for r in cor]):.0f} → {med([r['new_err'] for r in cor]):.0f} px")
    print(f"    평균 오차 {sum(r['base_err'] for r in cor)/max(1,len(cor)):.0f} → "
          f"{sum(r['new_err'] for r in cor)/max(1,len(cor)):.0f} px")
    print(f"    40px 초과(손봐야 함) {sum(1 for r in cor if r['base_err']>40)} → "
          f"{sum(1 for r in cor if r['new_err']>40)} 개")
    print(f"    개선 {len(imp)} / 악화 {len(wor)}")
    if wor:
        print("      악화:", [(r["number"], f"{r['base_err']:.0f}→{r['new_err']:.0f}") for r in wor])

    print(f"\n[B] 교사 미수정 {len(unt)}개 — 암묵 합격 (이동량은 실패 조건 아님)")
    mv = [r["moved"] for r in unt]
    print(f"    0px {sum(1 for m in mv if m==0)} | ≤5px {sum(1 for m in mv if 0<m<=5)} | "
          f"5~15px {sum(1 for m in mv if 5<m<=15)} | 15px 초과 {sum(1 for m in mv if m>15)}")
    big = sorted([r for r in unt if r["moved"] > 15], key=lambda r: -r["moved"])[:6]
    if big:
        print("      크게 이동(눈으로 확인 권장):",
              [(r["number"], f"p{r['page']}", f"{r['moved']:.0f}px") for r in big])

    print("\n[C] 내용 손실 검사 (가장 중요)")
    lost = lost_content(fx["pdf"], boxes, new_by_num)
    if lost:
        for l in lost[:10]:
            print(f"    ✗ #{l['number']} p{l['page']} {l['anchor']}: {l['pixels']}px / {l['columns']}열 잘림")
    else:
        print("    ✓ 잘려나간 글자 없음")

    ratio = (len(imp) / len(wor)) if wor else float("inf")
    passed = (not lost) and (not bad) and (ratio >= MIN_IMPROVE_RATIO or not wor)
    print("\n" + "=" * 52)
    print(f"내용 손실 0건        : {'✓' if not lost else '✗ ' + str(len(lost)) + '건'}")
    print(f"악화 {MAX_WORSE_PX}px 초과 0건 : {'✓' if not bad else '✗ ' + str(len(bad)) + '건'}")
    print(f"개선/악화 ≥ {MIN_IMPROVE_RATIO:.0f}배   : "
          f"{'✓' if ratio >= MIN_IMPROVE_RATIO else '✗'} ({len(imp)}/{len(wor)} = "
          f"{'∞' if ratio == float('inf') else f'{ratio:.1f}'}배)")
    print(f"{'합격 — 반영해도 됩니다' if passed else '불합격 — 반영하지 마세요'}")
    print("=" * 52)

    result.update(rows=rows, lost=lost, improved=len(imp), worsened=len(wor), passed=passed)
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", help="채점 결과를 이 경로에 저장")
    ap.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"),
                    help="저장해 둔 두 결과를 비교")
    args = ap.parse_args()

    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))

    if args.compare:
        a = json.loads(Path(args.compare[0]).read_text(encoding="utf-8"))
        b = json.loads(Path(args.compare[1]).read_text(encoding="utf-8"))
        ea = {r["number"]: r["new_err"] for r in a["rows"]}
        eb = {r["number"]: r["new_err"] for r in b["rows"]}
        imp = [n for n in ea if n in eb and eb[n] < ea[n] - 2]
        wor = [n for n in ea if n in eb and eb[n] > ea[n] + 2]
        print(f"개선 {len(imp)} / 악화 {len(wor)}")
        if wor:
            print("  악화:", [(n, f"{ea[n]:.0f}→{eb[n]:.0f}") for n in wor])
        return 0

    pdf = fx["pdf"]
    if not Path(pdf).exists():
        raise SystemExit(f"고정 데이터의 PDF 를 찾을 수 없습니다: {pdf}\n"
                         f"(backend/pdf_pipeline 에서 실행하세요)")
    print(f"고정 데이터: {FIXTURE.name} — {fx['total']}개 중 교사 수정분 {fx['corrected']}개")
    res = report(fx, compute_boxes(pdf))
    if args.save:
        Path(args.save).write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
        print(f"결과 저장: {args.save}")
    return 0 if res["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
