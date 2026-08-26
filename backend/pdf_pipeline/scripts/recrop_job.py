"""이미 등록된 job 을 현재 크롭 알고리즘으로 다시 잘라 넣는다.

왜 필요한가:
  크롭 알고리즘을 고쳐도 이미 CMS 에 올라간 검수 대기분은 옛 결과 그대로다. 그렇다고
  통째로 다시 올리면 **교사가 손으로 고친 bbox 가 날아간다**. 그래서 "앞쪽 N페이지는
  손대지 않고 그 뒤만 새로 만든다".

사용법:
    python -m scripts.recrop_job <job_id> [--keep-pages N] [--apply]

  --apply 없이 돌리면 무엇이 바뀔지만 출력한다(기본 dry run).
"""
import argparse
import sys
import time
from pathlib import Path

import fitz
import numpy as np
from PIL import Image as PILImage

from pipeline.file_converter import extract_images_from_pdf
from pipeline.ocr_anchor_provider import (
    collect_color_labels, resolve_label_anchors, tighten_by_ink,
)
from pipeline.text_anchor_segmenter import find_anchors, segment_problems
from pipeline.solution_masker import strip_solutions
from storage.image_uploader import upload_cropped_images, upload_page_image
from storage.supabase_client import get_client, insert_staging_problems


def _resolve_pdf(source_pdf: str) -> Path:
    """staging 에 저장된 경로를 현재 작업 디렉토리 기준으로 찾는다."""
    p = Path(source_pdf)
    if p.exists():
        return p
    # 'backend\\pdf_pipeline\\uploads\\...' 처럼 저장돼 있으면 uploads 이후만 쓴다
    parts = p.parts
    if "uploads" in parts:
        rel = Path(*parts[parts.index("uploads"):])
        if rel.exists():
            return rel
    raise SystemExit(f"PDF 를 찾을 수 없습니다: {source_pdf}")


def _build_anchors(doc: fitz.Document):
    """디지털 PDF 면 텍스트 앵커, 스캔본이면 색 라벨. (anchors, grays) 반환."""
    anchors = find_anchors(doc)
    if anchors:
        return anchors, None

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
    return ({"font": "ocr", "size": 12.0,
             "columns": sorted({round(a["col_x0"], 1) for a in resolved}),
             "anchors": resolved, "cuts": cuts}, grays)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("job_id")
    ap.add_argument("--keep-pages", type=int, default=2,
                    help="이 페이지까지는 기존 행을 그대로 둔다 (기본 2)")
    ap.add_argument("--apply", action="store_true", help="실제로 DB 를 바꾼다")
    args = ap.parse_args()

    sb = get_client()
    old = sb.table("problem_staging").select(
        "id,page_number,problem_number,teacher_id,textbook_id,folder_id,category,source_pdf"
    ).eq("job_id", args.job_id).order("problem_number").execute().data
    if not old:
        raise SystemExit(f"job {args.job_id} 의 staging 행이 없습니다.")

    keep = [r for r in old if r["page_number"] <= args.keep_pages]
    drop = [r for r in old if r["page_number"] > args.keep_pages]
    meta = old[0]
    print(f"기존 {len(old)}건 → 보존 {len(keep)}건(p1~{args.keep_pages}) / "
          f"삭제대상 {len(drop)}건(p{args.keep_pages + 1}~)")

    pdf = _resolve_pdf(meta["source_pdf"])
    t0 = time.time()
    print("페이지 렌더(300dpi)...")
    rendered = {pi["page"]: pi
                for pi in extract_images_from_pdf(str(pdf), str(pdf.parent / "images"), dpi=300)}

    doc = fitz.open(str(pdf))
    anchors, grays = _build_anchors(doc)
    regions = segment_problems(doc, anchors)
    strip_solutions(doc, regions)
    if grays is not None:
        for r in regions:
            pg = doc[r["page"]]
            r["rect"] = tighten_by_ink(grays[r["page"]], r["rect"], pg.rect.width, pg.rect.height)
    regions.sort(key=lambda r: (r["page"], r["column"], r["anchor_y"]))
    print(f"전체 {len(regions)}개 영역 ({time.time() - t0:.0f}초)")

    head = sum(1 for r in regions if r["page"] + 1 <= args.keep_pages)
    print(f"p1~{args.keep_pages} 새 검출 {head}개 / 보존분 {len(keep)}개 "
          f"→ 새 번호는 {max(head, len(keep)) + 1} 부터")
    start_num = max(head, len(keep)) + 1

    crop_dir = pdf.parent / "cropped"
    crop_dir.mkdir(parents=True, exist_ok=True)
    items = []
    num = start_num
    for r in regions:
        pnum = r["page"] + 1
        if pnum <= args.keep_pages:
            continue
        pi = rendered.get(pnum)
        if pi is None:
            continue
        with PILImage.open(pi["image_path"]) as img:
            pw, ph = img.size
            rect = doc[r["page"]].rect
            sx, sy = pw / rect.width, ph / rect.height
            x1, y1 = max(0, int(r["rect"].x0 * sx)), max(0, int(r["rect"].y0 * sy))
            x2, y2 = min(pw, int(r["rect"].x1 * sx)), min(ph, int(r["rect"].y1 * sy))
            if x2 - x1 < 20 or y2 - y1 < 20:
                continue
            out = crop_dir / f"recrop_page{pnum:03d}_prob{num:03d}.png"
            img.crop((x1, y1, x2, y2)).save(str(out))
        items.append({
            "number": num, "cropped_path": str(out), "page": pnum,
            "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2,
                     "page_width": pw, "page_height": ph},
            "image_path": pi["image_path"],
        })
        num += 1
    print(f"새 크롭 {len(items)}개 (번호 {start_num}~{num - 1})")

    if not args.apply:
        print("\n[DRY RUN] 실제로 반영하려면 --apply 를 붙이세요.")
        return

    print("페이지 이미지 업로드...")
    page_urls = {}
    for it in items:
        if it["page"] not in page_urls:
            page_urls[it["page"]] = upload_page_image(args.job_id, it["page"], it["image_path"])

    print("크롭 업로드...")
    uploaded = upload_cropped_images(items, args.job_id)

    print(f"옛 행 {len(drop)}건 삭제...")
    for r in drop:
        sb.table("problem_staging").delete().eq("id", r["id"]).execute()

    rows = []
    for it in uploaded:
        entry = {
            "problem_number": it["number"],
            "source_image_url": it["source_image_url"],
            "source_pdf": meta["source_pdf"],
            "source_page": it["page"],
            "confidence": 0.8,
            "answer_type": "short_answer",
            "difficulty_score": 2,
            "unit": "미분류",
            "category": meta["category"],
            "bbox": it["bbox"],
            "source_page_image_url": page_urls[it["page"]],
            "page_number": it["page"],
        }
        if meta.get("textbook_id"):
            entry["textbook_id"] = meta["textbook_id"]
        if meta.get("folder_id"):
            entry["folder_id"] = meta["folder_id"]
        rows.append(entry)

    print(f"새 행 {len(rows)}건 삽입...")
    insert_staging_problems(args.job_id, meta["teacher_id"], rows)

    final = sb.table("problem_staging").select("page_number,problem_number") \
        .eq("job_id", args.job_id).execute().data
    dup = len(final) - len({r["problem_number"] for r in final})
    print(f"\n완료 — job 총 {len(final)}건 "
          f"(p1~{args.keep_pages} {sum(1 for r in final if r['page_number'] <= args.keep_pages)} / "
          f"이후 {sum(1 for r in final if r['page_number'] > args.keep_pages)}) / 번호중복 {dup}건")


if __name__ == "__main__":
    sys.exit(main())
