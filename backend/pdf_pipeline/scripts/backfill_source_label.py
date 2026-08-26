"""이미 올라간 job 의 staging 행에 '지면에 인쇄된 번호'(source_label)를 채운다.

왜 필요한가:
  빠른정답표는 지면 번호(쎈 "0243", 내신 "3")로 되어 있는데, staging 에는 순번
  (problem_number=1..120)만 있어서 맞출 수가 없다. 크롭할 때 이미 그 번호를 앵커로
  읽어 놓고 버렸던 것이라, 앵커를 다시 계산해 채우면 된다(크롭은 결정론적이라 재현된다).

사용법:
    python -m scripts.backfill_source_label <job_id> [--apply]

  --apply 없으면 무엇이 채워질지만 보여준다(기본 dry run).
"""
import argparse
import sys
from pathlib import Path

import fitz
import numpy as np

from pipeline.ocr_anchor_provider import (
    collect_color_labels, resolve_label_anchors, tighten_by_ink,
)
from pipeline.text_anchor_segmenter import find_anchors, segment_problems, infer_labels
from pipeline.solution_masker import strip_solutions
from storage.supabase_client import get_client


def _resolve_pdf(source_pdf: str) -> Path:
    p = Path(source_pdf)
    if p.exists():
        return p
    parts = p.parts
    if "uploads" in parts:
        rel = Path(*parts[parts.index("uploads"):])
        if rel.exists():
            return rel
    raise SystemExit(f"PDF 를 찾을 수 없습니다: {source_pdf}")


def compute_labels(pdf_path: str) -> list:
    """이 PDF 를 다시 잘라 읽기 순서대로의 지면번호 목록을 만든다."""
    doc = fitz.open(pdf_path)
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
    infer_labels(regions)
    regions.sort(key=lambda r: (r["page"], r["column"], r["anchor_y"]))
    return [r.get("source_label", "") for r in regions]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("job_id")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    sb = get_client()
    rows = sb.table("problem_staging").select(
        "id,problem_number,page_number,source_label,source_pdf"
    ).eq("job_id", args.job_id).order("problem_number").execute().data
    if not rows:
        raise SystemExit(f"job {args.job_id} 의 staging 행이 없습니다.")
    print(f"staging {len(rows)}건 (이미 채워진 것 {sum(1 for r in rows if r.get('source_label'))}건)")

    pdf = _resolve_pdf(rows[0]["source_pdf"])
    print(f"크롭 앵커 재계산: {pdf.name}")
    labels = compute_labels(str(pdf))
    print(f"영역 {len(labels)}개 / staging {len(rows)}건")
    if len(labels) != len(rows):
        raise SystemExit("영역 수와 staging 수가 달라 순서를 못 믿습니다 — 중단합니다.")

    empty = [i + 1 for i, x in enumerate(labels) if not x]
    print(f"지면번호를 못 읽은 것: {len(empty)}개 {empty[:10]}")
    print("예시:", [(r["problem_number"], lb) for r, lb in list(zip(rows, labels))[:6]])

    if not args.apply:
        print("\n[DRY RUN] 실제로 채우려면 --apply 를 붙이세요.")
        return

    n = 0
    for r, lb in zip(rows, labels):
        if not lb:
            continue
        sb.table("problem_staging").update({"source_label": lb}).eq("id", r["id"]).execute()
        n += 1
    print(f"staging {n}건에 지면번호 기록")

    # 이미 등록(승격)된 문제에도 같이 넣어 둔다 — 나중에 problems 쪽에서 맞출 수 있게.
    promoted = sb.table("problem_staging").select("promoted_problem_id,source_label") \
        .eq("job_id", args.job_id).not_.is_("promoted_problem_id", "null").execute().data
    m = 0
    for p in promoted:
        if not p.get("source_label"):
            continue
        sb.table("problems").update({"source_label": p["source_label"]}) \
            .eq("id", p["promoted_problem_id"]).execute()
        m += 1
    print(f"problems {m}건에도 반영")


if __name__ == "__main__":
    sys.exit(main())
