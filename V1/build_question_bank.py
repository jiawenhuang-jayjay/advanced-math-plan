"""
将扫描版《汤家凤高数.pdf》（2026 接力题典 1800·数一 基础篇高数全 11 章）
批量转换为：
  1. question_bank.json   — 结构化题库（含题干 LaTeX、第一步卡壳提示、公式与避坑、简短答案）
  2. question_bank.js     — 供 index.html 直接加载（本地 & GitHub Pages 通用）
  3. 1800高数基础题库.md  — 可全局搜索的 Markdown 电子题库

用法示例（在 PowerShell 中运行）：
  $env:OPENAI_API_KEY="sk-你的密钥"
  # 1) 先跑前 3 页测试效果（约花费 $0.05）
  python build_question_bank.py --test
  # 2) 满意后全量跑完全书（支持断点续传，中断后重跑不重复扣费）
  python build_question_bank.py --all --workers 3
  # 3) 只跑指定章节或指定 PDF 页码
  python build_question_bank.py --chapter ch1
  python build_question_bank.py --pages 11-15 --model gpt-4o
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import fitz  # PyMuPDF
from openai import OpenAI

BASE_DIR = Path(__file__).resolve().parent
PDF_PATH = BASE_DIR / "汤家凤高数.pdf"
CACHE_DIR = BASE_DIR / "question_bank_cache"
OUT_JSON = BASE_DIR / "question_bank.json"
OUT_JS = BASE_DIR / "question_bank.js"
OUT_MD = BASE_DIR / "1800高数基础题库.md"

# 书页 p 对应 PDF 页码 p + 7（1-indexed）
CHAPTER_RANGES = [
    ("ch1",  "Ch1 函数、极限、连续",         10, 21),
    ("ch2",  "Ch2 导数与微分",               22, 29),
    ("ch3",  "Ch3 中值定理与微分应用",       30, 37),
    ("ch4",  "Ch4 不定积分",                 38, 41),
    ("ch5",  "Ch5 定积分及应用",             42, 53),
    ("ch6",  "Ch6 多元函数微分学",           54, 62),
    ("ch7",  "Ch7 微分方程",                 63, 69),
    ("ch8",  "Ch8 二重积分",                 70, 77),
    ("ch9",  "Ch9 三重积分与曲线、曲面积分", 78, 87),
    ("ch10", "Ch10 无穷级数",                88, 98),
    ("ch11", "Ch11 向量代数与空间解析几何",  99, 103),
]

# 纯考点思维导图页（无题目）
SKIP_MINDMAP_PAGES = {10, 22}

SYSTEM_PROMPT = """你是一位精通考研数学一的教授兼专业 LaTeX 录入专家。
我将发给你《2026 考研数学接力题典 1800·数学一》基础篇高等数学的某一页扫描图。
请你精准识别本页中的所有习题，并严格按 JSON 格式返回：

{
  "questions": [
    {
      "section": "所属板块（如：入门测试-选择 / 入门测试-填空 / 入门测试-解答 / 基础精练-选择 / 基础精练-填空 / 基础精练-解答 / 入门测试-计算 / 基础精练-计算；若本页承接上一页未出现新大标题，请根据题型与题号合理判断）",
      "number": "题号（字符串，如 '1'、'24'）",
      "is_key": true或false（若该题正下方有虚线框写着“重点题目”则为 true，否则 false）,
      "topic": "简短考点标签（如：不定型极限(∞-∞)、中值定理证明、第二类曲面积分）",
      "question_md": "完整准确的题干（选择题保留 (A)(B)(C)(D) 选项）。行内公式用 $...$，独立公式用 $$...$$。务必核对上下标、极限趋近点、积分上下限与正负号，确保 JSON 中反斜杠正确转义。",
      "hint_step1": "第一步切入点提示（1~2 句话，只点破最关键的变形、换元、辅助函数或定理触发点，绝不剧透完整演算过程）",
      "key_formula": "本题最核心的 1~2 条公式或定理（可用 $...$ 表示）",
      "pitfall": "考研学生做这题最容易踩的 1 个坑（1 句话）",
      "final_answer": "简短最终答案（选择题写选项如 '(C)'，计算/填空写结果，证明题用 1 句话写核心辅助函数或放缩关键）"
    }
  ]
}

规则：
1. 如果本页仅有“本章考点汇总”思维导图、封面或空白，没有任何习题，直接返回 {"questions": []}。
2. 如果页面最上方有上一页跨页残留的半道题（没有题号），忽略该残留片段或标注 number 为 "续"。
3. 严禁编造题目，严格忠实于图片文字与数学符号；若某符号极度模糊，用 [模糊] 标出。
4. 只输出合法 JSON，不要输出任何额外解释或 markdown 代码块包裹。"""


def get_chapter_for_pdf_page(pdf_page: int) -> tuple[str, str]:
    for ch_id, ch_name, start_p, end_p in CHAPTER_RANGES:
        if start_p <= pdf_page <= end_p:
            return ch_id, ch_name
    return "other", "其他"


def render_page_to_b64(doc: fitz.Document, pdf_page_1based: int, dpi: int = 180) -> str:
    page = doc[pdf_page_1based - 1]
    pix = page.get_pixmap(dpi=dpi)
    img_bytes = pix.tobytes("jpeg", jpg_quality=88)
    return base64.b64encode(img_bytes).decode("ascii")


def process_single_page(
    client: OpenAI,
    pdf_page: int,
    model: str,
    dpi: int,
    force: bool,
) -> tuple[int, dict, dict]:
    cache_file = CACHE_DIR / f"page_{pdf_page:03d}.json"
    ch_id, ch_name = get_chapter_for_pdf_page(pdf_page)
    book_page = pdf_page - 7

    if cache_file.exists() and not force:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        return pdf_page, data, {"cached": True, "prompt_tokens": 0, "completion_tokens": 0}

    if pdf_page in SKIP_MINDMAP_PAGES:
        data = {"pdf_page": pdf_page, "book_page": book_page, "chapter": ch_id, "chapter_name": ch_name, "questions": []}
        cache_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return pdf_page, data, {"cached": False, "prompt_tokens": 0, "completion_tokens": 0}

    with fitz.open(PDF_PATH) as doc:
        b64_img = render_page_to_b64(doc, pdf_page, dpi=dpi)

    user_text = (
        f"当前页属于：{ch_name}（原书第 {book_page} 页 / PDF 第 {pdf_page} 页）。"
        "请精准提取本页全部习题并生成第一步提示、核心公式、易错点与简短答案。"
    )

    last_err = None
    for attempt in range(1, 4):
        try:
            resp = client.chat.completions.create(
                model=model,
                response_format={"type": "json_object"},
                temperature=0.1,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_text},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{b64_img}",
                                    "detail": "high",
                                },
                            },
                        ],
                    },
                ],
            )
            raw_content = resp.choices[0].message.content or '{"questions": []}'
            parsed = json.loads(raw_content)
            questions = parsed.get("questions", [])
            usage = {
                "cached": False,
                "prompt_tokens": getattr(resp.usage, "prompt_tokens", 0) or 0,
                "completion_tokens": getattr(resp.usage, "completion_tokens", 0) or 0,
            }
            data = {
                "pdf_page": pdf_page,
                "book_page": book_page,
                "chapter": ch_id,
                "chapter_name": ch_name,
                "questions": questions,
            }
            cache_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            return pdf_page, data, usage
        except Exception as e:
            last_err = e
            wait_s = attempt * 3
            print(f"  [重试 {attempt}/3] PDF 第 {pdf_page} 页失败: {e}，{wait_s}s 后重试...", flush=True)
            time.sleep(wait_s)

    raise RuntimeError(f"PDF 第 {pdf_page} 页连续失败: {last_err}")


def merge_and_export() -> int:
    all_questions = []
    cache_files = sorted(CACHE_DIR.glob("page_*.json"))

    for cf in cache_files:
        page_data = json.loads(cf.read_text(encoding="utf-8"))
        ch_id = page_data["chapter"]
        ch_name = page_data["chapter_name"]
        book_page = page_data["book_page"]
        pdf_page = page_data["pdf_page"]

        for idx, q in enumerate(page_data.get("questions", []), start=1):
            num = str(q.get("number", idx)).strip()
            sec = str(q.get("section", "基础精练")).strip()
            all_questions.append({
                "id": f"{ch_id}-p{book_page}-{idx}",
                "chapter": ch_id,
                "chapter_name": ch_name,
                "book_page": book_page,
                "pdf_page": pdf_page,
                "section": sec,
                "number": num,
                "is_key": bool(q.get("is_key", False)),
                "topic": str(q.get("topic", "")).strip(),
                "question_md": str(q.get("question_md", "")).strip(),
                "hint_step1": str(q.get("hint_step1", "")).strip(),
                "key_formula": str(q.get("key_formula", "")).strip(),
                "pitfall": str(q.get("pitfall", "")).strip(),
                "final_answer": str(q.get("final_answer", "")).strip(),
            })

    # 1. Export JSON
    OUT_JSON.write_text(json.dumps(all_questions, ensure_ascii=False, indent=2), encoding="utf-8")

    # 2. Export JS for zero-CORS HTML loading
    js_payload = (
        "// 由 build_question_bank.py 自动生成，供 高数四轮复习规划.html 直接加载\n"
        f"window.QUESTION_BANK = {json.dumps(all_questions, ensure_ascii=False)};\n"
    )
    OUT_JS.write_text(js_payload, encoding="utf-8")

    # 3. Export clean Markdown
    md_lines = [
        "# 《2026 接力题典 1800·数一》高数基础篇电子题库（含卡壳提示）",
        "",
        f"> 已收录题数：**{len(all_questions)} 题**（按原书页码排序，自动标注重点题目与第一步切入点）",
        "",
    ]
    last_ch = None
    for q in all_questions:
        if q["chapter_name"] != last_ch:
            md_lines.append(f"\n## {q['chapter_name']}\n")
            last_ch = q["chapter_name"]
        key_tag = " ⭐**重点题目**" if q["is_key"] else ""
        md_lines.append(
            f"### {q['section']} · 第 {q['number']} 题（P{q['book_page']}）{key_tag} `[{q['topic']}]`\n"
        )
        md_lines.append(q["question_md"] + "\n")
        md_lines.append(f"- **💡 第一步提示**：{q['hint_step1']}")
        md_lines.append(f"- **📌 核心公式**：{q['key_formula']}")
        md_lines.append(f"- **⚠️ 易错避坑**：{q['pitfall']}")
        md_lines.append(f"- **✅ 参考答案**：{q['final_answer']}\n")

    OUT_MD.write_text("\n".join(md_lines), encoding="utf-8")
    return len(all_questions)


def parse_page_spec(spec: str) -> list[int]:
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            pages.update(range(int(a), int(b) + 1))
        else:
            pages.add(int(part))
    return sorted(p for p in pages if 10 <= p <= 103)


def main() -> None:
    parser = argparse.ArgumentParser(description="批量提取《汤家凤高数.pdf》为结构化电子题库")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--test", action="store_true", help="快速测试模式：仅处理 PDF 第 11–13 页（约 3 页，花费极低）")
    group.add_argument("--all", action="store_true", help="全量模式：处理全书高数 11 章全部题目页（PDF 第 11–103 页）")
    group.add_argument("--chapter", type=str, help="仅处理指定章节，如 ch1 ~ ch11")
    group.add_argument("--pages", type=str, help="指定 PDF 页码，如 11-15 或 11,12,18")
    group.add_argument("--merge-only", action="store_true", help="不调用 API，仅将已有缓存重新合并导出为 JSON/JS/MD")

    parser.add_argument("--model", type=str, default="gpt-4o", help="OpenAI 视觉模型名称（默认 gpt-4o，也可换 gpt-4.1）")
    parser.add_argument("--dpi", type=int, default=180, help="PDF 渲染清晰度（默认 180，兼顾公式精度与 Token 成本）")
    parser.add_argument("--workers", type=int, default=3, help="并发线程数（默认 3，避免触发速率限制）")
    parser.add_argument("--force", action="store_true", help="忽略本地缓存，强制重跑选中页面")
    args = parser.parse_args()

    if not PDF_PATH.exists():
        sys.exit(f"找不到 PDF 文件：{PDF_PATH}")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if args.merge_only:
        total = merge_and_export()
        print(f"已重新合并导出 {total} 道题 -> {OUT_JSON.name}, {OUT_JS.name}, {OUT_MD.name}")
        return

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        sys.exit(
            "未检测到环境变量 OPENAI_API_KEY！\n"
            "请先在 PowerShell 中执行：\n"
            '  $env:OPENAI_API_KEY="sk-你的OpenAI密钥"\n'
            "然后再运行本脚本。"
        )

    base_url = os.environ.get("OPENAI_BASE_URL", "").strip() or None
    client = OpenAI(api_key=api_key, base_url=base_url)

    if args.test:
        target_pages = [11, 12, 13]
    elif args.all:
        target_pages = [p for p in range(11, 104) if p not in SKIP_MINDMAP_PAGES]
    elif args.chapter:
        ch_key = args.chapter.lower().strip()
        match = [r for r in CHAPTER_RANGES if r[0] == ch_key]
        if not match:
            sys.exit(f"未知章节：{args.chapter}（可选 ch1 ~ ch11）")
        _, _, s_p, e_p = match[0]
        target_pages = [p for p in range(s_p, e_p + 1) if p not in SKIP_MINDMAP_PAGES]
    else:
        target_pages = parse_page_spec(args.pages)

    print(f"目标 PDF 页数：{len(target_pages)} 页 | 模型：{args.model} | 并发：{args.workers}")
    t0 = time.time()
    total_prompt_tok = 0
    total_comp_tok = 0
    failed_pages = []

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {
            pool.submit(process_single_page, client, p, args.model, args.dpi, args.force): p
            for p in target_pages
        }
        done_cnt = 0
        for fut in as_completed(futures):
            p = futures[fut]
            done_cnt += 1
            try:
                _, data, usage = fut.result()
                q_n = len(data.get("questions", []))
                total_prompt_tok += usage["prompt_tokens"]
                total_comp_tok += usage["completion_tokens"]
                status = "命中缓存" if usage["cached"] else f"识别 {q_n} 题 ({usage['prompt_tokens']}+{usage['completion_tokens']} tok)"
                print(f"[{done_cnt}/{len(target_pages)}] PDF P{p} (书 P{p-7}) -> {status}", flush=True)
            except Exception as exc:
                failed_pages.append((p, str(exc)))
                print(f"[{done_cnt}/{len(target_pages)}] PDF P{p} ❌ 失败: {exc}", flush=True)

    total_q = merge_and_export()
    elapsed = time.time() - t0
    print("\n================ 执行汇总 ================")
    print(f"耗时：{elapsed:.1f}s | 累计导出题库：{total_q} 题")
    print(f"本次新增消耗 Token：输入 {total_prompt_tok:,} / 输出 {total_comp_tok:,}")
    print(f"输出文件：\n  - {OUT_JSON}\n  - {OUT_JS}\n  - {OUT_MD}")
    if failed_pages:
        print(f"⚠️ 以下 {len(failed_pages)} 页失败（直接重跑同命令即可自动断点续传）：")
        for p, err in failed_pages:
            print(f"  PDF P{p}: {err}")


if __name__ == "__main__":
    main()
