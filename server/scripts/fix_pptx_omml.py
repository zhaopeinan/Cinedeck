#!/usr/bin/env python3
"""
Prepare PPTX for LibreOffice export: use equation fallback images or rasterize OMML.
"""
import os
import re
import sys
import zipfile
import tempfile
import shutil
import xml.etree.ElementTree as ET
from typing import Optional, Tuple, List

M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"


def _tag(name: str) -> str:
    return f"{{{M_NS}}}{name}"


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


# Office Math often uses Mathematical Alphanumeric Symbols (U+1D400+) and
# Letterlike Symbols (U+2100+). Common fonts (DejaVu/default) lack glyphs → tofu.
_MATH_LETTERLIKE = {
    0x2102: "C", 0x210A: "g", 0x210B: "H", 0x210C: "H", 0x210D: "H",
    0x210E: "h", 0x210F: "h", 0x2110: "I", 0x2111: "I", 0x2112: "L",
    0x2113: "l", 0x2115: "N", 0x2119: "P", 0x211A: "Q", 0x211B: "R",
    0x211C: "R", 0x211D: "R", 0x2124: "Z", 0x212C: "B", 0x212D: "C",
    0x212F: "e", 0x2130: "E", 0x2131: "F", 0x2133: "M", 0x2134: "o",
}


def normalize_math_alnum(text: str) -> str:
    """Map Math Italic/Bold/Script Unicode letters to plain ASCII."""
    out = []
    for ch in text:
        cp = ord(ch)
        if cp in _MATH_LETTERLIKE:
            out.append(_MATH_LETTERLIKE[cp])
            continue
        # Mathematical Alphanumeric Symbols block
        if 0x1D400 <= cp <= 0x1D7FF:
            # Bold A-Z / a-z
            if 0x1D400 <= cp <= 0x1D419:
                out.append(chr(ord("A") + (cp - 0x1D400)))
            elif 0x1D41A <= cp <= 0x1D433:
                out.append(chr(ord("a") + (cp - 0x1D41A)))
            # Italic A-Z / a-z
            elif 0x1D434 <= cp <= 0x1D44D:
                out.append(chr(ord("A") + (cp - 0x1D434)))
            elif 0x1D44E <= cp <= 0x1D467:
                out.append(chr(ord("a") + (cp - 0x1D44E)))
            # Bold italic
            elif 0x1D468 <= cp <= 0x1D481:
                out.append(chr(ord("A") + (cp - 0x1D468)))
            elif 0x1D482 <= cp <= 0x1D49B:
                out.append(chr(ord("a") + (cp - 0x1D482)))
            # Digits (bold / double-struck / sans …)
            elif 0x1D7CE <= cp <= 0x1D7D7:
                out.append(chr(ord("0") + (cp - 0x1D7CE)))
            elif 0x1D7D8 <= cp <= 0x1D7E1:
                out.append(chr(ord("0") + (cp - 0x1D7D8)))
            elif 0x1D7E2 <= cp <= 0x1D7EB:
                out.append(chr(ord("0") + (cp - 0x1D7E2)))
            elif 0x1D7EC <= cp <= 0x1D7F5:
                out.append(chr(ord("0") + (cp - 0x1D7EC)))
            elif 0x1D7F6 <= cp <= 0x1D7FF:
                out.append(chr(ord("0") + (cp - 0x1D7F6)))
            else:
                out.append("?")
            continue
        # thin spaces etc.
        if cp in (0x2005, 0x2006, 0x2009, 0x200A, 0x200B, 0xFEFF):
            out.append(" ")
            continue
        out.append(ch)
    s = "".join(out)
    # Operators that many fonts miss → ASCII-safe
    s = (
        s.replace("≈", " ~= ")
        .replace("≪", " << ")
        .replace("≫", " >> ")
        .replace("≤", "<=")
        .replace("≥", ">=")
        .replace("×", "*")
        .replace("÷", "/")
        .replace("·", "*")
    )
    return re.sub(r" +", " ", s).strip()


def omml_to_plain(elem: ET.Element) -> str:
    """Readable plain-text formula for Pillow (no LaTeX)."""
    tag = _local(elem.tag)
    if tag in ("oMath", "oMathPara", "num", "den", "e", "sub", "sup", "ctrlPr", "fPr", "sSubPr", "sSupPr", "oMathParaPr"):
        return "".join(omml_to_plain(c) for c in elem)
    if tag == "r":
        raw = "".join((c.text or "") for c in elem if _local(c.tag) == "t")
        return normalize_math_alnum(raw)
    if tag == "f":
        num = elem.find(_tag("num"))
        den = elem.find(_tag("den"))
        a = omml_to_plain(num) if num is not None else ""
        b = omml_to_plain(den) if den is not None else ""
        return f"({a})/({b})" if (" " in a or " " in b) else f"{a}/{b}"
    if tag == "sSub":
        e = elem.find(_tag("e"))
        sub = elem.find(_tag("sub"))
        a = omml_to_plain(e) if e is not None else ""
        b = omml_to_plain(sub) if sub is not None else ""
        return f"{a}_{b}"
    if tag == "sSup":
        e = elem.find(_tag("e"))
        sup = elem.find(_tag("sup"))
        a = omml_to_plain(e) if e is not None else ""
        b = omml_to_plain(sup) if sup is not None else ""
        return f"{a}^{b}"
    return "".join(omml_to_plain(c) for c in elem)


def extract_omml_lines(choice_xml: str) -> List[str]:
    lines: List[str] = []
    para_blocks = re.findall(r"<m:oMathPara\b[^>]*>.*?</m:oMathPara>", choice_xml, re.DOTALL)
    if not para_blocks:
        para_blocks = re.findall(r"<m:oMath\b[^>]*>.*?</m:oMath>", choice_xml, re.DOTALL)
    for block in para_blocks:
        try:
            wrapped = (
                f'<root xmlns:m="{M_NS}" xmlns:a="{A_NS}">{block}</root>'
            )
            root = ET.fromstring(wrapped)
        except ET.ParseError:
            continue
        for omml_para in root.iter(_tag("oMathPara")):
            text = re.sub(r"\s+", " ", omml_to_plain(omml_para)).strip()
            if text:
                lines.append(text)
        for omml in root.iter(_tag("oMath")):
            text = re.sub(r"\s+", " ", omml_to_plain(omml)).strip()
            if text and text not in lines:
                lines.append(text)
    return lines


def _pick_font(size: int = 18):
    from PIL import ImageFont
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render_plain_text_png(
    lines: List[str],
    out_path: str,
    width_px: int = 900,
    height_px: Optional[int] = None,
) -> bool:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return False
    lines = [normalize_math_alnum(x) for x in lines]
    if not lines:
        return False

    # Target canvas = slide formula box aspect (EMU→px ~ 914400 EMU/inch, 150dpi)
    if height_px is None or height_px < 40:
        height_px = max(120, 40 * len(lines) + 40)

    # Fit font to canvas
    font_size = max(14, min(28, height_px // max(len(lines) + 1, 2)))
    font = _pick_font(font_size)
    img = Image.new("RGBA", (width_px, height_px), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)

    # Measure total text block
    sizes = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        sizes.append((bbox[2] - bbox[0], bbox[3] - bbox[1]))
    gap = max(8, font_size // 2)
    total_h = sum(h for _, h in sizes) + gap * max(0, len(lines) - 1)
    max_w = max((w for w, _ in sizes), default=0)

    # Shrink font if overflow
    while (total_h > height_px - 16 or max_w > width_px - 24) and font_size > 11:
        font_size -= 1
        font = _pick_font(font_size)
        sizes = []
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=font)
            sizes.append((bbox[2] - bbox[0], bbox[3] - bbox[1]))
        gap = max(6, font_size // 2)
        total_h = sum(h for _, h in sizes) + gap * max(0, len(lines) - 1)
        max_w = max((w for w, _ in sizes), default=0)

    y = max(8, (height_px - total_h) // 2)
    x = 12
    for i, line in enumerate(lines):
        draw.text((x, y), line, fill=(26, 74, 122, 255), font=font)
        y += sizes[i][1] + gap

    img.save(out_path, "PNG")
    return os.path.isfile(out_path) and os.path.getsize(out_path) > 100


def render_mathtext_png(
    lines: List[str],
    out_path: str,
    width_px: int = 900,
    height_px: Optional[int] = None,
) -> bool:
    if not lines:
        return False
    plain_lines = [normalize_math_alnum(x) for x in lines]
    return render_plain_text_png(plain_lines, out_path, width_px, height_px)


def shape_size_px(fb_inner: str) -> Tuple[int, int]:
    """Read a:ext cx/cy (EMU) from fallback shape → ~150dpi pixels."""
    m = re.search(r'<a:ext\s+cx="(\d+)"\s+cy="(\d+)"', fb_inner)
    if not m:
        return 900, 240
    # 914400 EMU = 1 inch; 150 dpi
    cx, cy = int(m.group(1)), int(m.group(2))
    w = max(200, int(cx / 914400 * 150))
    h = max(80, int(cy / 914400 * 150))
    return w, h



def load_rels(rels_path: str) -> dict[str, str]:
    rels: dict[str, str] = {}
    if not os.path.isfile(rels_path):
        return rels
    root = ET.parse(rels_path).getroot()
    for rel in root.findall(f"{{{REL_NS}}}Relationship"):
        rid, target = rel.get("Id"), rel.get("Target")
        if rid and target:
            rels[rid] = target
    return rels


def write_rels(rels_path: str, rels: dict[str, str]) -> None:
    types: dict[str, str] = {}
    if os.path.isfile(rels_path):
        root = ET.parse(rels_path).getroot()
        for rel in root.findall(f"{{{REL_NS}}}Relationship"):
            rid = rel.get("Id")
            if rid:
                types[rid] = rel.get("Type") or IMAGE_REL

    lines = [
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        f"<Relationships xmlns=\"{REL_NS}\">",
    ]
    for rid, target in sorted(rels.items(), key=lambda x: x[0]):
        rel_type = types.get(rid) or IMAGE_REL
        lines.append(f"<Relationship Id=\"{rid}\" Type=\"{rel_type}\" Target=\"{target}\"/>")
    lines.append("</Relationships>")
    with open(rels_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def resolve_media_path(target: str, work_root: str) -> Optional[str]:
    if not target or target == "NULL":
        return None
    norm = target.replace("\\", "/")
    if norm.startswith("../"):
        norm = "ppt/" + norm[3:]
    abs_path = os.path.join(work_root, norm)
    return abs_path if os.path.isfile(abs_path) else None


def patch_slide_xml(
    xml: str,
    slide_rels: dict[str, str],
    work_root: str,
    slide_key: str,
    eq_counter: int,
) -> Tuple[str, int, int]:
    fixes = 0
    eq_counter_start = eq_counter
    alt_pattern = re.compile(r"<mc:AlternateContent\b[^>]*>.*?</mc:AlternateContent>", re.DOTALL)

    def replacer(match: re.Match[str]) -> str:
        nonlocal fixes, eq_counter
        block = match.group(0)
        fb_m = re.search(r"<mc:Fallback\b[^>]*>(.*)</mc:Fallback>", block, re.DOTALL)
        choice_m = re.search(r"<mc:Choice\b[^>]*>(.*)</mc:Choice>", block, re.DOTALL)
        if not fb_m:
            return block

        fb_inner = fb_m.group(1)
        embed_m = re.search(r"r:embed=\"([^\"]*)\"", fb_inner)
        embed = embed_m.group(1) if embed_m else ""
        media_abs = resolve_media_path(slide_rels.get(embed, ""), work_root) if embed else None

        if media_abs and os.path.getsize(media_abs) > 50:
            fixes += 1
            return fb_inner

        if not choice_m:
            return fb_inner

        lines = extract_omml_lines(choice_m.group(1))
        if not lines:
            return fb_inner

        media_dir = os.path.join(work_root, "ppt", "media")
        os.makedirs(media_dir, exist_ok=True)
        img_name = f"eq_{slide_key}_{eq_counter}.png"
        img_abs = os.path.join(media_dir, img_name)
        w_px, h_px = shape_size_px(fb_inner)
        if not render_mathtext_png(lines, img_abs, width_px=w_px, height_px=h_px):
            return fb_inner

        new_rid = f"rIdEq{eq_counter}"
        eq_counter += 1
        slide_rels[new_rid] = f"../media/{img_name}"

        new_inner = fb_inner
        if embed_m:
            new_inner = new_inner.replace(f'r:embed="{embed}"', f'r:embed="{new_rid}"', 1)
        fixes += 1
        return new_inner

    new_xml = alt_pattern.sub(replacer, xml)
    return new_xml, fixes, eq_counter


def fix_pptx(src_path: str) -> bool:
    if not os.path.isfile(src_path):
        print("SKIP:no_file")
        return False

    with zipfile.ZipFile(src_path, "r") as zin:
        names = [n.replace("\\", "/") for n in zin.namelist()]
        has_math = any(
            n.startswith("ppt/slides/slide") and n.endswith(".xml")
            and (b"mc:AlternateContent" in zin.read(n) or b"m:oMath" in zin.read(n))
            for n in names
            if n.startswith("ppt/slides/slide") and n.endswith(".xml")
        )
    if not has_math:
        print("SKIP:no_math")
        return False

    work = tempfile.mkdtemp(prefix="pptx_omml_fix_")
    try:
        with zipfile.ZipFile(src_path, "r") as zin:
            zin.extractall(work)

        total_fixes = 0
        eq_counter = 0
        slides_dir = os.path.join(work, "ppt", "slides")
        for slide_file in sorted(os.listdir(slides_dir)):
            if not slide_file.startswith("slide") or not slide_file.endswith(".xml"):
                continue
            slide_path = os.path.join(slides_dir, slide_file)
            rels_path = os.path.join(slides_dir, "_rels", slide_file + ".rels")
            with open(slide_path, "r", encoding="utf-8") as f:
                xml = f.read()
            if "mc:AlternateContent" not in xml:
                continue
            rels = load_rels(rels_path)
            new_xml, fixes, eq_counter = patch_slide_xml(
                xml, rels, work, slide_file.replace(".xml", ""), eq_counter,
            )
            if fixes:
                with open(slide_path, "w", encoding="utf-8") as f:
                    f.write(new_xml)
                write_rels(rels_path, rels)
                total_fixes += fixes

        if total_fixes == 0:
            print("SKIP:no_fixes")
            return False

        fd, tmp = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for root_dir, _, files in os.walk(work):
                for fn in files:
                    abs_path = os.path.join(root_dir, fn)
                    arc = os.path.relpath(abs_path, work).replace("\\", "/")
                    zout.write(abs_path, arc)
        shutil.move(tmp, src_path)
        print(f"FIXED:{total_fixes}")
        return True
    except Exception as e:
        print(f"ERROR:{e}")
        return False
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("ERROR:usage fix_pptx_omml.py <pptx>")
        sys.exit(1)
    fix_pptx(sys.argv[1])
    sys.exit(0)
