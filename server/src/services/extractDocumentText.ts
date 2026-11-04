import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Extract readable text from uploaded documents for explain-animation topics.
 * PPTX: slide body + notes via python-pptx.
 */
export async function extractDocumentText(filePath: string, fileName: string): Promise<string> {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('上传文件不存在');
  }
  const ext = path.extname(fileName || filePath).toLowerCase();

  if (['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf-8').slice(0, 40000).trim();
  }

  if (ext === '.pptx' || ext === '.ppt') {
    if (ext === '.ppt') {
      throw new Error('暂不支持旧版 .ppt，请另存为 .pptx 后再上传');
    }
    return extractPptxText(filePath);
  }

  if (ext === '.pdf') {
    throw new Error('暂不支持直接解析 PDF，请粘贴文本或上传 PPTX / TXT / MD');
  }

  throw new Error(`暂不支持 ${ext || '该'} 格式，请上传 .pptx / .txt / .md，或直接粘贴选题`);
}

async function extractPptxText(filePath: string): Promise<string> {
  const safePath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const script = `
import json, sys
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

prs = Presentation('${safePath}')
pages = []
for i, slide in enumerate(prs.slides, 1):
    parts = []
    for shape in slide.shapes:
        try:
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                t = (shape.text_frame.text or "").strip()
                if t:
                    parts.append(t)
            elif shape.shape_type == MSO_SHAPE_TYPE.TABLE:
                rows = []
                for row in shape.table.rows:
                    cells = []
                    for cell in row.cells:
                        ct = (cell.text or "").strip()
                        if ct:
                            cells.append(ct)
                    if cells:
                        rows.append(" | ".join(cells))
                if rows:
                    parts.append("\\n".join(rows))
        except Exception:
            pass
    note = ""
    try:
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
            note = (slide.notes_slide.notes_text_frame.text or "").strip()
    except Exception:
        pass
    body = "\\n".join(parts).strip()
    if body or note:
        block = f"【第{i}页】"
        if body:
            block += "\\n" + body
        if note:
            block += "\\n备注：" + note
        pages.append(block)

text = "\\n\\n".join(pages).strip()
print(json.dumps({"ok": True, "pages": len(prs.slides), "text": text}, ensure_ascii=False))
`;
  try {
    const { stdout } = await execFileAsync('python3', ['-c', script], {
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim());
    const text = String(result.text || '').trim();
    if (!text || text.length < 8) {
      throw new Error('未能从 PPT 中提取到可用文字（可能全是图片页）。请粘贴选题摘要后再试');
    }
    // Cap for LLM context
    const capped = text.length > 35000
      ? `${text.slice(0, 35000)}\n\n…（已截断，共 ${result.pages} 页）`
      : text;
    return `课件共 ${result.pages} 页，内容大纲如下：\n\n${capped}`;
  } catch (err: any) {
    if (err?.message && /未能从 PPT|暂不支持/.test(err.message)) throw err;
    const detail = err?.stderr || err?.message || String(err);
    throw new Error(`PPTX 解析失败：${String(detail).slice(0, 400)}`);
  }
}
