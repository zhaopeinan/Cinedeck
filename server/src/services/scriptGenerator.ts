import { ProjectService } from './projectService';
import { LlmService } from './llmService';
import fs from 'fs';
import path from 'path';

// 中文 TTS 语速：约 5.5 字/秒
const CHARS_PER_SECOND = 5.5;

export interface ScriptProgress {
  stage: 'idle' | 'allocating' | 'drafting' | 'refining' | 'optimizing' | 'optimizing_notes' | 'adjusting' | 'checking' | 'done' | 'failed';
  currentPage: number;
  totalPages: number;
  updatedAt: string;
  error?: string;
}

export class ScriptGeneratorService {
  private progressMap = new Map<string, ScriptProgress>();
  private cancelMap = new Map<string, boolean>();

  constructor(
    private projectService: ProjectService,
    private llmService: LlmService,
  ) {}

  getProgress(projectId: string): ScriptProgress | null {
    return this.progressMap.get(projectId) || null;
  }

  /**
   * 获取循环重试配置（从激活的 LLM 配置读取）
   */
  private getRetryConfig(userId: string): { maxCycles: number; toleranceRate: number } {
    const config = this.llmService.getActiveConfig(userId);
    return {
      maxCycles: config?.max_retry_cycles ?? 3,
      toleranceRate: config?.tolerance_rate ?? 0.1,
    };
  }

  /**
   * 检查字数是否达标
   * @returns true=达标, false=未达标
   */
  private isCharCountAcceptable(actualChars: number, targetChars: number, toleranceRate: number): boolean {
    if (targetChars <= 0) return true;
    const diff = Math.abs(actualChars - targetChars) / targetChars;
    return diff <= toleranceRate;
  }

  /**
   * 单页字数不达标时的重试：针对性地扩写或缩写
   */
  private async retrySingleForCharCount(
    content: string,
    targetChars: number,
    pageIndex: number,
    userId: string,
  ): Promise<string> {
    const diff = targetChars - content.length;
    const prompt = diff > 0
      ? `当前解说词字数不足，目标是 ${targetChars} 字，当前 ${content.length} 字，还差 ${diff} 字。请扩写以下解说词，增加约 ${diff} 字的详细内容，保持原有信息不变，全部使用中文，口语化自然：
${content}`
      : `当前解说词字数过多，目标是 ${targetChars} 字，当前 ${content.length} 字，需减少约 ${-diff} 字。请缩写以下解说词，删减冗余但保留核心信息，全部使用中文，口语化自然：
${content}`;

    const result = await this.llmService.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.5, maxTokens: Math.max(1024, Math.round(targetChars * 2.5)), userId },
    );
    return result.replace(/^["'「]|["'」]$/g, '').trim();
  }

  /**
   * 两阶段生成解说词
   * @param projectId 项目 ID
   * @param targetDurationSec 目标总时长（秒），0 表示按备注长度自动估算
   * @param useExistingNote 是否利用已有备注作为参考
   */
  async generateScripts(projectId: string, targetDurationSec: number, useExistingNote: boolean, userId: string) {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const slides = this.projectService.getSlides(projectId) as any[];
    if (slides.length === 0) throw new Error('没有可用的页面');

    const total = slides.length;
    this.setProgress(projectId, 'allocating', 0, total);

    // ===== 时长分配 =====
    // 基于备注内容长度（复杂度代理）做加权分配
    const weights = slides.map(s => {
      const noteLen = s.note_content?.length || 0;
      // 有备注的页面权重 = max(备注字数, 基础权重50)；无备注给基础权重
      return Math.max(noteLen, 50);
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    // 如果未指定目标时长，根据备注总字数估算
    const totalDuration = targetDurationSec > 0
      ? targetDurationSec
      : slides.reduce((sum, s) => sum + (s.estimated_duration || 0), 0) || (total * 30);

    const allocations = weights.map(w => (w / totalWeight) * totalDuration);
    const targetChars = allocations.map(d => Math.round(d * CHARS_PER_SECOND));

    // ===== 阶段一：多模态生成初稿 =====
    this.setProgress(projectId, 'drafting', 0, total);
    const drafts: { pageIndex: number; content: string }[] = [];

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      this.setProgress(projectId, 'drafting', i, total);

      const imagePath = slide.image_path;
      const hasImage = imagePath && fs.existsSync(imagePath);
      const noteContent = useExistingNote && slide.note_content ? slide.note_content : null;
      const targetCharCount = targetChars[i];
      const targetSeconds = Math.round(allocations[i]);

      // 构造提示词
      let prompt = `你是一位专业的课程讲解员。请根据这张PPT页面`;
      if (noteContent) {
        prompt += `和以下备注内容`;
      }
      prompt += `，生成口语化的解说词。\n\n`;
      prompt += `【重要 - 字数要求】\n`;
      prompt += `- 本页目标讲解时长：${targetSeconds} 秒\n`;
      prompt += `- 本页目标字数：${targetCharCount} 字（必须达到，允许 ±10% 浮动，即不少于 ${Math.round(targetCharCount * 0.9)} 字）\n`;
      prompt += `- 整个课程共 ${total} 页，目标总时长 ${Math.round(totalDuration / 60)} 分钟\n\n`;
      prompt += `【生成要求】\n`;
      prompt += `1. 内容要充实、详细，充分讲解页面中的知识点，不要只是简单概括\n`;
      prompt += `2. 口语化、自然流畅，像老师讲课一样娓娓道来\n`;
      prompt += `3. 对页面中的关键概念、数据、图表做详细解释和展开\n`;
      prompt += `4. 不要说"这一页"、"接下来我们看"之类的过渡语\n`;
      prompt += `5. 严格达到目标字数要求，这是硬性约束\n`;
      prompt += `6. 全部使用中文，不要使用英文专有术语或缩写（如 API、LLM、Agent 等需译为中文或用中文解释），因为后续 AI 配音可能会读错英文\n`;
      prompt += `7. 不要做任何问候或开场白（如"大家好"、"你好"、"上午好"、"今天我们来聊聊"、"我们今天要讲的是"等），直接开始讲解内容，不要加任何前面的铺垫，把每一页都当成中间页处理\n\n`;
      if (noteContent) {
        prompt += `【备注内容（作为参考，可扩展但不要缩减）】\n${noteContent}\n\n`;
      }
      prompt += `请直接输出解说词正文（${targetCharCount} 字左右），不要加任何标注、说明或字数统计。\n\n【最后强调】开头第一句话必须是具体的知识点讲解，绝对不要出现"大家好"、"你好"、"我们今天要讲的是"、"今天我们来聊聊"等任何问候或开场铺垫，直接切入正题。`;

      try {
        let content: string;
        // max_tokens 估算：目标字数 * 2（中文约 1 字 ≈ 1.5 token）+ 余量
        const maxTokens = Math.max(1024, Math.round(targetCharCount * 2.5));
        if (hasImage) {
          content = await this.llmService.chatWithImage(prompt, imagePath, {
            systemPrompt: '你是一位专业的课程内容讲解员，擅长将PPT内容转化为生动自然的口语化解说词。你的解说词内容详实、讲解深入，能够根据图片中的详细信息展开讲解。',
            temperature: 0.7,
            maxTokens,
            userId,
          });
        } else {
          // 无图片，仅用备注生成
          const fallbackPrompt = noteContent
            ? `${prompt}\n\n（注意：无法获取PPT图片，请仅根据备注内容生成解说词）`
            : `请生成一段约 ${targetCharCount} 字的通用课程过渡解说词。`;
          content = await this.llmService.chat(
            [{ role: 'user', content: fallbackPrompt }],
            { temperature: 0.7, maxTokens, userId },
          );
        }

        // 清理可能的 markdown 标记
        content = content.replace(/^["'「]|["'」]$/g, '').trim();

        drafts.push({ pageIndex: slide.page_index, content });
        // 立即保存初稿，前端轮询即可实时看到
        this.saveSingleScript(projectId, slide.page_index, content);
      } catch (err: any) {
        // 单页失败不阻断，用备注或占位内容作为 fallback，完善阶段可能补上
        const fallbackContent = noteContent || `[此页解说词生成失败，待完善阶段补充]`;
        drafts.push({ pageIndex: slide.page_index, content: fallbackContent });
        // 失败也保存，让用户看到状态
        this.saveSingleScript(projectId, slide.page_index, fallbackContent);
        console.error(`[ScriptGenerator] 第${slide.page_index + 1}页初稿生成失败:`, err.message);
      }
    }

    // ===== 阶段二：统一完善（纯文本模型） =====
    this.setProgress(projectId, 'refining', total, total);

    // 以初稿为基础，完善阶段的结果用于覆盖
    let finalScripts = new Map<number, string>();
    drafts.forEach(d => finalScripts.set(d.pageIndex, d.content));

    try {
      const draftText = drafts
        .map(d => `【第${d.pageIndex + 1}页】\n${d.content}`)
        .join('\n\n');

      const refinePrompt = `以下是一个课程视频各页面的解说词初稿。请统一优化，确保：
1. 整体连贯流畅，各页之间衔接自然
2. 各页讲解时长分配合理（总目标约 ${Math.round(totalDuration / 60)} 分钟）
3. 语言口语化、生动自然
4. 不要添加"接下来"、"这一页"等过渡语
5. 保持每页内容的核心信息不变
6. 必须为每一页都生成内容，共 ${total} 页（page_index 从 0 到 ${total - 1}），不能遗漏任何一页
7. 去掉所有问候性话语和开场铺垫（如"大家好"、"你好"、"我们今天要讲的是"等），每页都直接进入内容讲解

请按以下JSON格式返回结果（只返回JSON，不要其他内容）：
\`\`\`json
[
  { "page_index": 0, "content": "解说词内容..." },
  { "page_index": 1, "content": "解说词内容..." }
]
\`\`\`

解说词初稿：
${draftText}

【最后强调】每一页的 content 开头第一句话必须是具体的知识点讲解，绝对不要出现"大家好"、"你好"、"我们今天要讲的是"、"今天我们来聊聊"等任何问候或开场铺垫，直接切入正题。`;

      const response = await this.llmService.chat(
        [{ role: 'user', content: refinePrompt }],
        { temperature: 0.5, userId },
      );

      // 解析 JSON
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { page_index: number; content: string }[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          // 用完善结果覆盖初稿（按 page_index 匹配）
          for (const item of parsed) {
            const content = (item.content || '').trim();
            if (content) {
              finalScripts.set(item.page_index, content);
            }
          }
        }
      }
    } catch {
      // 完善阶段失败，使用初稿结果
    }

    // ===== 先保存当前结果，让用户能看到已生成内容 =====
    this.saveScripts(projectId, slides, finalScripts);

    // ===== 循环检查：字数达标校验与重试 =====
    const { maxCycles, toleranceRate } = this.getRetryConfig(userId);
    this.setProgress(projectId, 'checking', 0, total);

    for (let cycle = 0; cycle < maxCycles; cycle++) {
      // 检查是否被用户取消
      if (this.cancelMap.get(projectId)) {
        console.log(`[ScriptGenerator] 用户取消重试，使用当前结果`);
        this.cancelMap.delete(projectId);
        break;
      }

      let allAcceptable = true;
      let checkIndex = 0;
      for (const slide of slides) {
        // 每页检查前也检查取消标志
        if (this.cancelMap.get(projectId)) break;

        const pageIndex = slide.page_index;
        const content = finalScripts.get(pageIndex) || '';
        const targetCharCount = targetChars[checkIndex];
        checkIndex++;
        this.setProgress(projectId, 'checking', checkIndex, total);

        if (!content || this.isCharCountAcceptable(content.length, targetCharCount, toleranceRate)) continue;

        allAcceptable = false;
        console.log(`[ScriptGenerator] 第${pageIndex + 1}页字数不达标（第${cycle + 1}轮）：目标 ${targetCharCount}，实际 ${content.length}，重试中...`);
        try {
          const retried = await this.retrySingleForCharCount(content, targetCharCount, pageIndex, userId);
          if (retried) {
            finalScripts.set(pageIndex, retried);
            // 重试成功后立即保存该页，用户可实时看到更新
            this.saveSingleScript(projectId, pageIndex, retried);
          }
        } catch (err: any) {
          console.error(`[ScriptGenerator] 第${pageIndex + 1}页第${cycle + 1}轮重试失败:`, err.message);
        }
      }
      if (allAcceptable) {
        console.log(`[ScriptGenerator] 所有页面字数达标（第${cycle + 1}轮检查通过）`);
        break;
      }
    }

    // ===== 最终保存到数据库 =====
    this.saveScripts(projectId, slides, finalScripts);

    this.setProgress(projectId, 'done', total, total);
  }

  /**
   * 保存所有页的解说词到数据库
   */
  private saveScripts(projectId: string, slides: any[], finalScripts: Map<number, string>) {
    for (const slide of slides) {
      const pageIndex = slide.page_index;
      const content = finalScripts.get(pageIndex) || '';
      this.saveSingleScript(projectId, pageIndex, content);
    }
  }

  /**
   * 保存单页解说词到数据库
   */
  private saveSingleScript(projectId: string, pageIndex: number, content: string) {
    const charCount = content.length;
    const estimatedDuration = charCount / CHARS_PER_SECOND;
    this.projectService.updateSlide(projectId, pageIndex, {
      script_content: content,
      script_status: content ? 'generated' : 'failed',
      note_content: content,
      note_char_count: charCount,
      note_status: content ? 'loaded' : 'empty',
      estimated_duration: estimatedDuration,
      dubbing_status: 'pending',
    });
  }

  /**
   * 取消正在进行的生成/重试
   */
  cancelGeneration(projectId: string) {
    this.cancelMap.set(projectId, true);
  }

  /**
   * 优化解说词：保留原内容，仅将英文术语替换为中文
   */
  async optimizeScripts(projectId: string, userId: string) {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const slides = this.projectService.getSlides(projectId) as any[];
    const total = slides.length;
    this.setProgress(projectId, 'optimizing', 0, total);

    for (let i = 0; i < total; i++) {
      const slide = slides[i];
      const originalContent = slide.note_content || slide.script_content || '';
      if (!originalContent) {
        this.setProgress(projectId, 'optimizing', i + 1, total);
        continue;
      }

      let finalContent = originalContent;
      try {
        const prompt = `请优化以下解说词，要求：
1. 保留原有所有内容，不要增删任何信息
2. 将所有英文单词、专有术语、缩写全部替换为中文（如 API → 应用程序接口，LLM → 大语言模型，Agent → 智能体，ReAct → 推理行动，Coding → 编程等）
3. 保持语言口语化、自然流畅
4. 不要添加"这一页"等过渡语
5. 不要添加任何说明、标注或字数统计
6. 去掉所有问候性话语和开场铺垫（如"你好"、"各位专家好"、"大家好"、"我们今天要讲的是"等），直接进入内容讲解

原始解说词：
${originalContent}

请直接输出优化后的解说词正文。

【最后强调】开头第一句话必须是具体的知识点讲解，绝对不要出现"大家好"、"你好"、"我们今天要讲的是"、"今天我们来聊聊"等任何问候或开场铺垫，直接切入正题。`;

        const content = await this.llmService.chat(
          [{ role: 'user', content: prompt }],
          { temperature: 0.3, userId },
        );

        finalContent = content.replace(/^["'「]|["'」]$/g, '').trim();
      } catch (err: any) {
        // 失败保留原文
        console.error(`[ScriptGenerator] 第${slide.page_index + 1}页优化失败:`, err.message);
      }

      // 立即保存该页，前端轮询即可实时看到
      const charCount = finalContent.length;
      const estimatedDuration = charCount / CHARS_PER_SECOND;
      this.projectService.updateSlide(projectId, slide.page_index, {
        script_content: finalContent,
        script_status: 'generated',
        note_content: finalContent,
        note_char_count: charCount,
        note_status: 'loaded',
        estimated_duration: estimatedDuration,
        dubbing_status: 'pending',
      });

      this.setProgress(projectId, 'optimizing', i + 1, total);
    }

    this.setProgress(projectId, 'done', total, total);
  }

  /**
   * 批量优化备注：仅把英文术语替换为中文，不触碰解说词（script_content）
   * 与 optimizeScripts 的优化规则一致，但只更新 note_content。
   */
  async optimizeNotes(projectId: string, userId: string) {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const slides = this.projectService.getSlides(projectId) as any[];
    const total = slides.length;
    this.setProgress(projectId, 'optimizing_notes', 0, total);

    for (let i = 0; i < total; i++) {
      const slide = slides[i];
      const originalContent = slide.note_content || '';
      if (!originalContent) {
        this.setProgress(projectId, 'optimizing_notes', i + 1, total);
        continue;
      }

      let finalContent = originalContent;
      try {
        const prompt = `请优化以下备注内容，要求：
1. 保留原有所有内容，不要增删任何信息
2. 将所有英文单词、专有术语、缩写全部替换为中文（如 API → 应用程序接口，LLM → 大语言模型，Agent → 智能体，ReAct → 推理行动，Coding → 编程等）
3. 保持语言口语化、自然流畅
4. 不要添加"这一页"等过渡语
5. 不要添加任何说明、标注或字数统计
6. 去掉所有问候性话语和开场铺垫（如"你好"、"各位专家好"、"大家好"、"我们今天要讲的是"等），直接进入内容讲解

原始备注：
${originalContent}

请直接输出优化后的备注正文。

【最后强调】开头第一句话必须是具体的知识点讲解，绝对不要出现"大家好"、"你好"、"我们今天要讲的是"、"今天我们来聊聊"等任何问候或开场铺垫，直接切入正题。`;

        const content = await this.llmService.chat(
          [{ role: 'user', content: prompt }],
          { temperature: 0.3, userId },
        );

        finalContent = content.replace(/^["'「]|["'」]$/g, '').trim();
      } catch (err: any) {
        // 失败保留原文
        console.error(`[ScriptGenerator] 第${slide.page_index + 1}页备注优化失败:`, err.message);
      }

      // 立即保存该页，前端轮询即可实时看到
      const charCount = finalContent.length;
      const estimatedDuration = charCount / CHARS_PER_SECOND;
      this.projectService.updateSlide(projectId, slide.page_index, {
        note_content: finalContent,
        note_char_count: charCount,
        note_status: 'loaded',
        estimated_duration: estimatedDuration,
      });

      this.setProgress(projectId, 'optimizing_notes', i + 1, total);
    }

    this.setProgress(projectId, 'done', total, total);
  }

  /**
   * 调整解说词长度：根据目标时长扩写或缩写
   * @param projectId 项目 ID
   * @param targetDurationSec 目标总时长（秒），0 = 不调整
   */
  async adjustScriptsLength(projectId: string, targetDurationSec: number, userId: string) {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const slides = this.projectService.getSlides(projectId) as any[];
    const total = slides.length;
    if (targetDurationSec <= 0) throw new Error('目标时长必须大于 0');

    this.setProgress(projectId, 'adjusting', 0, total);

    // 按现有字数比例分配每页目标时长
    const totalCurrentChars = slides.reduce((sum, s) => sum + (s.note_char_count || 0), 0);

    for (let i = 0; i < total; i++) {
      const slide = slides[i];
      const originalContent = slide.note_content || slide.script_content || '';
      if (!originalContent) {
        this.setProgress(projectId, 'adjusting', i + 1, total);
        continue;
      }

      const currentChars = slide.note_char_count || originalContent.length;
      // 按比例分配目标时长
      const pageTargetSec = totalCurrentChars > 0
        ? (currentChars / totalCurrentChars) * targetDurationSec
        : targetDurationSec / total;
      const pageTargetChars = Math.round(pageTargetSec * CHARS_PER_SECOND);
      const diff = pageTargetChars - currentChars;

      let finalContent = originalContent;
      try {
        let prompt: string;
        if (diff > 0) {
          // 扩写
          prompt = `请扩写以下解说词，要求：
1. 保留原内容的核心信息，在此基础上扩展细节和解释
2. 目标字数：${pageTargetChars} 字（当前 ${currentChars} 字，需增加约 ${diff} 字）
3. 扩写要自然，不要简单重复或堆砌，增加有价值的内容展开
4. 全部使用中文，不要使用英文专有术语或缩写
5. 保持口语化、自然流畅
6. 不要添加"这一页"等过渡语
7. 去掉所有问候性话语和开场铺垫（如"你好"、"大家好"、"我们今天要讲的是"等），直接进入内容讲解`;
        } else {
          // 缩写
          prompt = `请缩写以下解说词，要求：
1. 保留原内容的核心信息和关键知识点
2. 目标字数：${pageTargetChars} 字（当前 ${currentChars} 字，需减少约 ${-diff} 字）
3. 删除冗余和重复内容，保持简洁但信息完整
4. 全部使用中文，不要使用英文专有术语或缩写
5. 保持口语化、自然流畅
6. 不要添加"这一页"等过渡语
7. 去掉所有问候性话语和开场铺垫（如"你好"、"大家好"、"我们今天要讲的是"等），直接进入内容讲解`;
        }

        prompt += `\n\n原始解说词：\n${originalContent}\n\n请直接输出调整后的解说词正文，不要加任何标注或说明。\n\n【最后强调】开头第一句话必须是具体的知识点讲解，绝对不要出现"大家好"、"你好"、"我们今天要讲的是"、"今天我们来聊聊"等任何问候或开场铺垫，直接切入正题。`;

        const content = await this.llmService.chat(
          [{ role: 'user', content: prompt }],
          { temperature: 0.5, userId },
        );

        let cleaned = content.replace(/^["'「]|["'」]$/g, '').trim();

        // 循环检查：字数达标校验与重试
        const { maxCycles, toleranceRate } = this.getRetryConfig(userId);
        for (let cycle = 0; cycle < maxCycles; cycle++) {
          if (this.isCharCountAcceptable(cleaned.length, pageTargetChars, toleranceRate)) break;
          console.log(`[ScriptGenerator] 批量调整第${slide.page_index + 1}页字数不达标（第${cycle + 1}轮）：目标 ${pageTargetChars}，实际 ${cleaned.length}，重试中...`);
          try {
            const retried = await this.retrySingleForCharCount(cleaned, pageTargetChars, slide.page_index, userId);
            if (retried) cleaned = retried;
          } catch (err: any) {
            console.error(`[ScriptGenerator] 批量调整第${slide.page_index + 1}页第${cycle + 1}轮重试失败:`, err.message);
            break;
          }
        }

        finalContent = cleaned;
      } catch (err: any) {
        console.error(`[ScriptGenerator] 第${slide.page_index + 1}页长度调整失败:`, err.message);
      }

      // 立即保存该页，前端轮询即可实时看到
      const charCount = finalContent.length;
      const estimatedDuration = charCount / CHARS_PER_SECOND;
      this.projectService.updateSlide(projectId, slide.page_index, {
        script_content: finalContent,
        script_status: 'generated',
        note_content: finalContent,
        note_char_count: charCount,
        note_status: 'loaded',
        estimated_duration: estimatedDuration,
        dubbing_status: 'pending',
      });

      this.setProgress(projectId, 'adjusting', i + 1, total);
    }

    this.setProgress(projectId, 'done', total, total);
  }

  async generateSingleScript(projectId: string, pageIndex: number, targetDurationSec: number, userId: string) {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const slides = this.projectService.getSlides(projectId) as any[];
    const slide = slides.find(s => s.page_index === pageIndex);
    if (!slide) throw new Error(`页面 ${pageIndex + 1} 不存在`);

    const total = slides.length;
    const targetCharCount = Math.round(targetDurationSec * CHARS_PER_SECOND);
    const noteContent = slide.note_content || null;

    const imagePath = slide.image_path;
    const hasImage = imagePath && fs.existsSync(imagePath);

    // 构造提示词
    let prompt = `你是一位专业的课程讲解员。请根据这张PPT页面`;
    if (noteContent) {
      prompt += `和以下备注内容`;
    }
    prompt += `，生成口语化的解说词。\n\n`;
    prompt += `【重要 - 字数要求】\n`;
    prompt += `- 本页目标讲解时长：${targetDurationSec} 秒\n`;
    prompt += `- 本页目标字数：${targetCharCount} 字（必须达到，允许 ±10% 浮动，即不少于 ${Math.round(targetCharCount * 0.9)} 字）\n`;
    prompt += `- 整个课程共 ${total} 页\n\n`;
    prompt += `【生成要求】\n`;
    prompt += `1. 内容要充实、详细，充分讲解页面中的知识点，不要只是简单概括\n`;
    prompt += `2. 口语化、自然流畅，像老师讲课一样娓娓道来\n`;
    prompt += `3. 对页面中的关键概念、数据、图表做详细解释和展开\n`;
    prompt += `4. 不要说"这一页"、"接下来我们看"之类的过渡语\n`;
    prompt += `5. 严格达到目标字数要求，这是硬性约束\n`;
    prompt += `6. 全部使用中文，不要使用英文专有术语或缩写（如 API、LLM、Agent 等需译为中文或用中文解释），因为后续 AI 配音可能会读错英文\n`;
    prompt += `7. 不要做任何问候或开场白（如"大家好"、"你好"、"上午好"、"今天我们来聊聊"、"我们今天要讲的是"等），直接开始讲解内容，不要加任何前面的铺垫，把每一页都当成中间页处理\n\n`;
    if (noteContent) {
      prompt += `【备注内容（作为参考，可扩展但不要缩减）】\n${noteContent}\n\n`;
    }
    prompt += `请直接输出解说词正文（${targetCharCount} 字左右），不要加任何标注、说明或字数统计。\n\n【最后强调】开头第一句话必须是具体的知识点讲解，绝对不要出现"大家好"、"你好"、"我们今天要讲的是"、"今天我们来聊聊"等任何问候或开场铺垫，直接切入正题。`;

    const maxTokens = Math.max(1024, Math.round(targetCharCount * 2.5));
    let content: string;

    if (hasImage) {
      content = await this.llmService.chatWithImage(prompt, imagePath, {
        systemPrompt: '你是一位专业的课程内容讲解员，擅长将PPT内容转化为生动自然的口语化解说词。你的解说词内容详实、讲解深入，能够根据图片中的详细信息展开讲解。',
        temperature: 0.7,
        maxTokens,
        userId,
      });
    } else {
      const fallbackPrompt = noteContent
        ? `${prompt}\n\n（注意：无法获取PPT图片，请仅根据备注内容生成解说词）`
        : `请生成一段约 ${targetCharCount} 字的通用课程过渡解说词。`;
      content = await this.llmService.chat(
        [{ role: 'user', content: fallbackPrompt }],
        { temperature: 0.7, maxTokens, userId },
      );
    }

    // 清理可能的 markdown 标记
    content = content.replace(/^["'「]|["'」]$/g, '').trim();

    // 循环检查：字数达标校验与重试
    const { maxCycles, toleranceRate } = this.getRetryConfig(userId);
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      if (this.isCharCountAcceptable(content.length, targetCharCount, toleranceRate)) {
        break;
      }
      console.log(`[ScriptGenerator] 单页${pageIndex + 1}字数不达标（第${cycle + 1}轮）：目标 ${targetCharCount}，实际 ${content.length}，重试中...`);
      try {
        const retried = await this.retrySingleForCharCount(content, targetCharCount, pageIndex, userId);
        if (retried) content = retried;
      } catch (err: any) {
        console.error(`[ScriptGenerator] 单页${pageIndex + 1}第${cycle + 1}轮重试失败:`, err.message);
        break;
      }
    }

    // 保存
    const charCount = content.length;
    const estimatedDuration = charCount / CHARS_PER_SECOND;
    this.projectService.updateSlide(projectId, pageIndex, {
      script_content: content,
      script_status: content ? 'generated' : 'failed',
      note_content: content,
      note_char_count: charCount,
      note_status: content ? 'loaded' : 'empty',
      estimated_duration: estimatedDuration,
      dubbing_status: 'pending',
    });

    return { content, charCount, estimatedDuration };
  }

  /**
   * 单页优化解说词：保留原内容，仅将英文术语替换为中文
   */
  async optimizeSingleScript(projectId: string, pageIndex: number, userId: string) {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const slides = this.projectService.getSlides(projectId) as any[];
    const slide = slides.find(s => s.page_index === pageIndex);
    if (!slide) throw new Error(`页面 ${pageIndex + 1} 不存在`);

    const originalContent = slide.note_content || slide.script_content || '';
    if (!originalContent) throw new Error('该页无解说词内容');

    const prompt = `请优化以下解说词，要求：
1. 保留原有所有内容，不要增删任何信息
2. 将所有英文单词、专有术语、缩写全部替换为中文（如 API → 应用程序接口，LLM → 大语言模型，Agent → 智能体，ReAct → 推理行动，Coding → 编程等）
3. 保持语言口语化、自然流畅
4. 不要添加"这一页"等过渡语
5. 不要添加任何说明、标注或字数统计
6. 去掉所有问候性话语和开场铺垫（如"你好"、"各位专家好"、"大家好"、"我们今天要讲的是"等），直接进入内容讲解

原始解说词：
${originalContent}

请直接输出优化后的解说词正文。

【最后强调】开头第一句话必须是具体的知识点讲解，绝对不要出现"大家好"、"你好"、"我们今天要讲的是"、"今天我们来聊聊"等任何问候或开场铺垫，直接切入正题。`;

    const content = await this.llmService.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.3, userId },
    );

    const cleaned = content.replace(/^["'「]|["'」]$/g, '').trim();

    const charCount = cleaned.length;
    const estimatedDuration = charCount / CHARS_PER_SECOND;
    this.projectService.updateSlide(projectId, pageIndex, {
      script_content: cleaned,
      script_status: 'generated',
      note_content: cleaned,
      note_char_count: charCount,
      note_status: 'loaded',
      estimated_duration: estimatedDuration,
      dubbing_status: 'pending',
    });

    return { content: cleaned, charCount, estimatedDuration };
  }

  /**
   * 单页调整解说词长度：根据目标时长扩写或缩写
   */
  async adjustSingleScriptLength(projectId: string, pageIndex: number, targetDurationSec: number, userId: string) {
    const project = this.projectService.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const slides = this.projectService.getSlides(projectId) as any[];
    const slide = slides.find(s => s.page_index === pageIndex);
    if (!slide) throw new Error(`页面 ${pageIndex + 1} 不存在`);

    const originalContent = slide.note_content || slide.script_content || '';
    if (!originalContent) throw new Error('该页无解说词内容');

    const currentChars = slide.note_char_count || originalContent.length;
    const targetCharCount = Math.round(targetDurationSec * CHARS_PER_SECOND);
    const diff = targetCharCount - currentChars;

    let prompt: string;
    if (diff > 0) {
      prompt = `请扩写以下解说词，要求：
1. 保留原内容的核心信息，在此基础上扩展细节和解释
2. 目标字数：${targetCharCount} 字（当前 ${currentChars} 字，需增加约 ${diff} 字）
3. 扩写要自然，不要简单重复或堆砌，增加有价值的内容展开
4. 全部使用中文，不要使用英文专有术语或缩写
5. 保持口语化、自然流畅
6. 不要添加"这一页"等过渡语
7. 去掉所有问候性话语和开场铺垫（如"你好"、"大家好"、"我们今天要讲的是"等），直接进入内容讲解`;
    } else {
      prompt = `请缩写以下解说词，要求：
1. 保留原内容的核心信息和关键知识点
2. 目标字数：${targetCharCount} 字（当前 ${currentChars} 字，需减少约 ${-diff} 字）
3. 删除冗余和重复内容，保持简洁但信息完整
4. 全部使用中文，不要使用英文专有术语或缩写
5. 保持口语化、自然流畅
6. 不要添加"这一页"等过渡语
7. 去掉所有问候性话语和开场铺垫（如"你好"、"大家好"、"我们今天要讲的是"等），直接进入内容讲解`;
    }

    prompt += `\n\n原始解说词：\n${originalContent}\n\n请直接输出调整后的解说词正文，不要加任何标注或说明。\n\n【最后强调】开头第一句话必须是具体的知识点讲解，绝对不要出现"大家好"、"你好"、"我们今天要讲的是"、"今天我们来聊聊"等任何问候或开场铺垫，直接切入正题。`;

    const maxTokens = Math.max(1024, Math.round(targetCharCount * 2.5));
    const content = await this.llmService.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.5, maxTokens, userId },
    );

    let cleaned = content.replace(/^["'「]|["'」]$/g, '').trim();

    // 循环检查：字数达标校验与重试
    const { maxCycles, toleranceRate } = this.getRetryConfig(userId);
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      if (this.isCharCountAcceptable(cleaned.length, targetCharCount, toleranceRate)) {
        break;
      }
      console.log(`[ScriptGenerator] 单页调整${pageIndex + 1}字数不达标（第${cycle + 1}轮）：目标 ${targetCharCount}，实际 ${cleaned.length}，重试中...`);
      try {
        const retried = await this.retrySingleForCharCount(cleaned, targetCharCount, pageIndex, userId);
        if (retried) cleaned = retried;
      } catch (err: any) {
        console.error(`[ScriptGenerator] 单页调整${pageIndex + 1}第${cycle + 1}轮重试失败:`, err.message);
        break;
      }
    }

    const charCount = cleaned.length;
    const estimatedDuration = charCount / CHARS_PER_SECOND;
    this.projectService.updateSlide(projectId, pageIndex, {
      script_content: cleaned,
      script_status: 'generated',
      note_content: cleaned,
      note_char_count: charCount,
      note_status: 'loaded',
      estimated_duration: estimatedDuration,
      dubbing_status: 'pending',
    });

    return { content: cleaned, charCount, estimatedDuration };
  }

  private setProgress(projectId: string, stage: ScriptProgress['stage'], currentPage: number, totalPages: number, error?: string) {
    this.progressMap.set(projectId, {
      stage,
      currentPage,
      totalPages,
      updatedAt: new Date().toISOString(),
      error,
    });
  }
}
