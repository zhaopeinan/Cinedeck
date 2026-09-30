import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProjectService } from './projectService';
import { normalizePptxZipPaths } from '../utils/pptxNormalize';
import { preparePptxEquationsForExport } from '../utils/pptxMathCompat';

const execFileAsync = promisify(execFile);
const THUMBNAIL_DIR = path.resolve(process.cwd(), '..', 'data', 'thumbnails');
const MAX_NOTE_CHAR_COUNT = 10000;
const MAX_PAGE_COUNT = 200;

interface SlideParseResult {
  pageIndex: number;
  imagePath: string;
  thumbnailPath: string;
  noteStatus: 'loaded' | 'empty' | 'read_failed' | 'too_long';
  noteContent: string | null;
  noteCharCount: number;
  estimatedDuration: number;
}

interface ParseResult {
  totalPages: number;
  slides: SlideParseResult[];
  errors: Array<{ pageIndex: number; type: string; message: string }>;
}

export class PptParserService {
  constructor(private projectService: ProjectService) {}

  async parsePpt(projectId: string): Promise<ParseResult> {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    this.projectService.updateProject(projectId, { parse_status: 'parsing' });

    try {
      const filePath = project.file_path;
      // WPS / Windows exports may use backslash ZIP paths — fix before LO / python-pptx
      normalizePptxZipPaths(filePath);

      const projectDir = path.dirname(filePath);
      const imagesDir = path.join(projectDir, 'images');
      const thumbnailsDir = path.join(projectDir, 'thumbnails');

      fs.mkdirSync(imagesDir, { recursive: true });
      fs.mkdirSync(thumbnailsDir, { recursive: true });

      // Use python-pptx to extract notes
      const notesResult = await this.extractNotes(filePath);

      if (notesResult.totalPages > MAX_PAGE_COUNT) {
        throw new Error(`PPT页数超过上限(${MAX_PAGE_COUNT}页)`);
      }

      // Use LibreOffice to convert PPT pages to images
      await this.convertToImages(filePath, imagesDir);

      const slides: SlideParseResult[] = [];
      const errors: ParseResult['errors'] = [];

      for (let i = 0; i < notesResult.totalPages; i++) {
        const pageIndex = i + 1;
        const noteData = notesResult.notes[i];
        const imagePath = path.join(imagesDir, `slide_${pageIndex}.png`);
        const thumbnailPath = path.join(thumbnailsDir, `slide_${pageIndex}_thumb.png`);

        // Generate thumbnail
        if (fs.existsSync(imagePath)) {
          await this.generateThumbnail(imagePath, thumbnailPath);
        }

        let noteStatus: SlideParseResult['noteStatus'] = 'loaded';
        let noteContent: string | null = null;
        let noteCharCount = 0;

        if (noteData.status === 'success' && noteData.content && noteData.content.trim()) {
          noteContent = noteData.content;
          noteCharCount = noteContent.length;
          if (noteCharCount > MAX_NOTE_CHAR_COUNT) {
            noteStatus = 'too_long';
          } else {
            noteStatus = 'loaded';
          }
        } else if (noteData.status === 'success') {
          noteStatus = 'empty';
        } else {
          noteStatus = 'read_failed';
          errors.push({ pageIndex, type: 'read_failed', message: noteData.error || '备注读取失败' });
        }

        // TTS 实际语速约 5.5 字/秒（中文），4 字/秒偏慢导致预估偏长
        const estimatedDuration = (noteStatus === 'loaded' || noteStatus === 'too_long') ? noteCharCount / 5.5 : 0;

        // Save to database
        this.projectService.createSlide(projectId, pageIndex, {
          thumbnailPath: fs.existsSync(thumbnailPath) ? thumbnailPath : undefined,
          imagePath: fs.existsSync(imagePath) ? imagePath : undefined,
          noteStatus,
          noteContent,
          noteCharCount,
          estimatedDuration,
        });

        slides.push({
          pageIndex,
          imagePath: fs.existsSync(imagePath) ? imagePath : '',
          thumbnailPath: fs.existsSync(thumbnailPath) ? thumbnailPath : '',
          noteStatus,
          noteContent,
          noteCharCount,
          estimatedDuration,
        });
      }

      const hasErrors = errors.length > 0;
      const hasLoadedNotes = slides.some(s => s.noteStatus === 'loaded');

      this.projectService.updateProject(projectId, {
        parse_status: hasErrors ? 'partial' : (hasLoadedNotes ? 'success' : 'failed'),
      });

      return { totalPages: notesResult.totalPages, slides, errors };
    } catch (error: any) {
      this.projectService.updateProject(projectId, { parse_status: 'failed' });
      throw error;
    }
  }

  private async extractNotes(filePath: string): Promise<{
    totalPages: number;
    notes: Array<{ status: string; content?: string; error?: string }>;
  }> {
    const script = `
import json
import sys
try:
    from pptx import Presentation
    prs = Presentation(r"${filePath.replace(/"/g, '\\"')}")
    result = {"totalPages": len(prs.slides), "notes": []}
    for slide in prs.slides:
        try:
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                text = slide.notes_slide.notes_text_frame.text
                result["notes"].append({"status": "success", "content": text})
            else:
                result["notes"].append({"status": "success", "content": ""})
        except Exception as e:
            result["notes"].append({"status": "error", "error": str(e)})
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;
    const { stdout, stderr } = await execFileAsync('python3', ['-c', script], { timeout: 60000 });

    const result = JSON.parse(stdout.trim());
    if (result.error) throw new Error(result.error);
    return result;
  }

  private async findLibreOffice(): Promise<string> {
    // macOS 常见路径
    const macPaths = [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/local/bin/libreoffice',
      '/opt/homebrew/bin/libreoffice',
    ];
    // Linux 常见路径
    const linuxPaths = [
      '/usr/bin/libreoffice',
      '/usr/bin/soffice',
      '/snap/bin/libreoffice',
    ];

    const candidates = [...macPaths, ...linuxPaths];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    // 最后尝试 which
    try {
      const { stdout } = await execFileAsync('which', ['libreoffice'], { timeout: 5000 });
      if (stdout.trim()) return stdout.trim();
    } catch {}

    try {
      const { stdout } = await execFileAsync('which', ['soffice'], { timeout: 5000 });
      if (stdout.trim()) return stdout.trim();
    } catch {}

    return '';
  }

  /**
   * Render PPTX pages to slide_N.png under outputDir (LibreOffice + pdf2image/pdftoppm).
   * Used by full parse and MOOC layout preview.
   */
  async renderPptToImages(filePath: string, outputDir: string): Promise<number> {
    fs.mkdirSync(outputDir, { recursive: true });
    await this.convertToImages(filePath, outputDir);
    const pages = fs.readdirSync(outputDir)
      .filter((f) => /^slide_\d+\.png$/i.test(f));
    return pages.length;
  }

  private async convertToImages(filePath: string, outputDir: string): Promise<void> {
    const libreOfficePath = await this.findLibreOffice();
    if (!libreOfficePath) {
      throw new Error(
        '未找到LibreOffice，请先安装：\n' +
        '  macOS:  brew install --cask libreoffice\n' +
        '  Ubuntu: sudo apt install -y libreoffice-impress\n' +
        '  CentOS: sudo yum install -y libreoffice-impress'
      );
    }

    normalizePptxZipPaths(filePath);
    preparePptxEquationsForExport(filePath);

    // 先转成 PDF，再从 PDF 逐页导出 PNG
    const pdfDir = path.join(outputDir, '_pdf_temp');
    fs.mkdirSync(pdfDir, { recursive: true });

    // Isolated LO profile avoids lock conflicts when multiple jobs run
    const profileDir = path.join(outputDir, '_lo_profile');
    fs.mkdirSync(profileDir, { recursive: true });
    const profileUri = `file://${profileDir}`;

    let convertErr = '';
    try {
      const result = await execFileAsync(libreOfficePath, [
        '--headless',
        `-env:UserInstallation=${profileUri}`,
        '--convert-to', 'pdf',
        '--outdir', pdfDir,
        filePath,
      ], { timeout: 180000 });
      convertErr = (result.stderr || result.stdout || '').toString();
    } catch (err: any) {
      convertErr = (err?.stderr || err?.message || '').toString();
      console.warn(`[PPTX] LibreOffice convert warning/error: ${convertErr.slice(0, 300)}`);
    }

    // 找到生成的 PDF
    let pdfFiles = fs.existsSync(pdfDir) ? fs.readdirSync(pdfDir).filter(f => f.endsWith('.pdf')) : [];
    if (pdfFiles.length === 0) {
      // One more attempt after re-normalize / copy to ASCII temp name
      const asciiCopy = path.join(outputDir, '_input.pptx');
      fs.copyFileSync(filePath, asciiCopy);
      normalizePptxZipPaths(asciiCopy);
      try {
        await execFileAsync(libreOfficePath, [
          '--headless',
          `-env:UserInstallation=${profileUri}`,
          '--convert-to', 'pdf',
          '--outdir', pdfDir,
          asciiCopy,
        ], { timeout: 180000 });
      } catch (err: any) {
        convertErr = (err?.stderr || err?.message || convertErr || '').toString();
      }
      pdfFiles = fs.existsSync(pdfDir) ? fs.readdirSync(pdfDir).filter(f => f.endsWith('.pdf')) : [];
      try { fs.unlinkSync(asciiCopy); } catch { /* ignore */ }
    }
    if (pdfFiles.length === 0) {
      const hint = convertErr.trim().slice(0, 300);
      throw new Error(
        'LibreOffice转换PDF失败，未生成PDF文件'
        + (hint ? `（${hint}）` : '')
        + '。若文件来自 WPS/Windows，请用 PowerPoint 另存为标准 PPTX 后重试。',
      );
    }
    const pdfPath = path.join(pdfDir, pdfFiles[0]);

    // 用 pdf2image (Python) 从 PDF 逐页导出 PNG
    const script = `
import sys
try:
    from pdf2image import convert_from_path
    images = convert_from_path(r"${pdfPath.replace(/"/g, '\\"')}", dpi=150)
    for i, img in enumerate(images):
        out = r"${outputDir.replace(/"/g, '\\"')}" + "/slide_" + str(i + 1) + ".png"
        img.save(out, "PNG")
    print(json.dumps({"pages": len(images)}))
except ImportError:
    # pdf2image 未安装，回退到 poppler pdftoppm
    import subprocess
    import json
    result = subprocess.run(["pdftoppm", "-png", "-r", "150", r"${pdfPath.replace(/"/g, '\\"')}", r"${path.join(outputDir, 'slide').replace(/"/g, '\\"')}"], capture_output=True, text=True)
    print(json.dumps({"fallback": "pdftoppm", "rc": result.returncode}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;
    try {
      const { stdout } = await execFileAsync('python3', ['-c', `import json\n${script}`], { timeout: 120000 });
      const result = JSON.parse(stdout.trim());
      if (result.error) throw new Error(result.error);
    } catch (err: any) {
      // pdf2image 不可用时，尝试用 pdftoppm 直接转换
      try {
        await execFileAsync('pdftoppm', [
          '-png', '-r', '150',
          pdfPath,
          path.join(outputDir, 'slide'),
        ], { timeout: 120000 });
      } catch {
        // 最后回退：LibreOffice 直接转 PNG（只输出首页或合并图）
        try {
          await execFileAsync(libreOfficePath, [
            '--headless', '--convert-to', 'png',
            '--outdir', outputDir,
            filePath,
          ], { timeout: 120000 });
        } catch {
          throw new Error('PPT转图片失败。请安装 poppler：brew install poppler（macOS）或 apt install poppler-utils（Linux）');
        }
      }
    }

    // 清理临时 PDF 目录
    try { fs.rmSync(pdfDir, { recursive: true, force: true }); } catch {}

    // 统一文件名：确保每页为 slide_N.png
    this.normalizeImageFiles(outputDir);
  }

  private normalizeImageFiles(outputDir: string): void {
    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.png'));
    for (const file of files) {
      // pdftoppm 输出格式: slide-1.png, slide-2.png
      // LibreOffice 直接输出可能为: 测试PPT.png (单文件)
      const numMatch = file.match(/(?:slide[-_]?|)(\d+)\.png$/i);
      if (numMatch) {
        const num = parseInt(numMatch[1]);
        const targetName = `slide_${num}.png`;
        if (file !== targetName) {
          const src = path.join(outputDir, file);
          const dst = path.join(outputDir, targetName);
          if (!fs.existsSync(dst)) {
            fs.renameSync(src, dst);
          } else {
            fs.unlinkSync(src);
          }
        }
      }
    }
  }

  private async generateThumbnail(imagePath: string, thumbnailPath: string): Promise<void> {
    // Simple thumbnail: use sips on macOS
    try {
      await execFileAsync('sips', [
        '--resampleWidth', '320',
        '--out', thumbnailPath,
        imagePath,
      ], { timeout: 10000 });
    } catch {
      // Fallback: copy original as thumbnail
      if (!fs.existsSync(thumbnailPath)) {
        fs.copyFileSync(imagePath, thumbnailPath);
      }
    }
  }

  async reparseSlide(projectId: string, pageIndex: number): Promise<SlideParseResult | null> {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const notesResult = await this.extractNotes(project.file_path);
    const noteData = notesResult.notes[pageIndex - 1];
    if (!noteData) return null;

    let noteStatus: SlideParseResult['noteStatus'] = 'loaded';
    let noteContent: string | null = null;
    let noteCharCount = 0;

    if (noteData.status === 'success' && noteData.content && noteData.content.trim()) {
      noteContent = noteData.content;
      noteCharCount = noteContent.length;
      if (noteCharCount > MAX_NOTE_CHAR_COUNT) {
        noteStatus = 'too_long';
      }
    } else if (noteData.status === 'success') {
      noteStatus = 'empty';
    } else {
      noteStatus = 'read_failed';
    }

    const estimatedDuration = (noteStatus === 'loaded' || noteStatus === 'too_long') ? noteCharCount / 5.5 : 0;

    this.projectService.updateSlide(projectId, pageIndex, {
      note_status: noteStatus,
      note_content: noteContent,
      note_char_count: noteCharCount,
      estimated_duration: estimatedDuration,
    });

    const slide = this.projectService.getSlide(projectId, pageIndex) as any;
    return {
      pageIndex,
      imagePath: slide?.image_path || '',
      thumbnailPath: slide?.thumbnail_path || '',
      noteStatus,
      noteContent,
      noteCharCount,
      estimatedDuration,
    };
  }
}
