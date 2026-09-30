import axios from 'axios';
import path from 'path';
import fs from 'fs';

const OPENCUT_BASE_URL = process.env.OPENCUT_BASE_URL || 'http://localhost:5174';

export class OpenCutAdapter {
  private baseUrl: string;
  private available: boolean = false;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || OPENCUT_BASE_URL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await axios.get(`${this.baseUrl}/api/health`, { timeout: 5000 });
      this.available = res.status === 200;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  async initProject(params: {
    projectId: string;
    slides: Array<{ pageIndex: number; imagePath: string; duration: number }>;
    audios: Array<{ pageIndex: number; audioPath: string; duration: number }>;
    aspectRatio: string;
  }): Promise<{ id: string; status: string; timeline: any }> {
    const available = await this.isAvailable();
    if (!available) {
      // Fallback: create a local timeline representation
      return this.createLocalTimeline(params);
    }

    try {
      const res = await axios.post(`${this.baseUrl}/api/projects`, params, { timeout: 30000 });
      return res.data;
    } catch {
      return this.createLocalTimeline(params);
    }
  }

  private createLocalTimeline(params: any) {
    const videoClips = params.slides.map((slide: any, index: number) => ({
      id: `video_${slide.pageIndex}`,
      slideIndex: slide.pageIndex,
      startTime: params.slides.slice(0, index).reduce((sum: number, s: any) => sum + s.duration, 0),
      endTime: params.slides.slice(0, index + 1).reduce((sum: number, s: any) => sum + s.duration, 0),
      sourcePath: slide.imagePath,
      duration: slide.duration,
    }));

    const audioClips = params.audios.map((audio: any) => {
      const slideIndex = params.slides.findIndex((s: any) => s.pageIndex === audio.pageIndex);
      const startTime = slideIndex >= 0 ? videoClips[slideIndex].startTime : 0;
      return {
        id: `audio_${audio.pageIndex}`,
        slideIndex: audio.pageIndex,
        startTime,
        endTime: startTime + audio.duration,
        sourcePath: audio.audioPath,
        duration: audio.duration,
        volume: 1,
      };
    });

    const totalDuration = videoClips.length > 0 ? videoClips[videoClips.length - 1].endTime : 0;

    return {
      id: `local_${params.projectId}`,
      status: 'ready',
      timeline: {
        tracks: [
          { id: 'video', type: 'video', clips: videoClips },
          { id: 'audio', type: 'audio', clips: audioClips },
        ],
        duration: totalDuration,
      },
    };
  }

  async getTimeline(projectId: string): Promise<any> {
    // Read from local file
    const timelinePath = path.resolve(process.cwd(), '..', 'data', 'projects', projectId, 'timeline.json');
    if (fs.existsSync(timelinePath)) {
      return JSON.parse(fs.readFileSync(timelinePath, 'utf-8'));
    }
    return null;
  }

  async updateTimeline(projectId: string, timeline: any): Promise<any> {
    const timelinePath = path.resolve(process.cwd(), '..', 'data', 'projects', projectId, 'timeline.json');
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
    return timeline;
  }

  async getPreviewUrl(projectId: string): Promise<string> {
    return `/api/v1/projects/${projectId}/video/play`;
  }

  async startExport(projectId: string, params: { format: string; resolution?: string; frameRate?: number }): Promise<string> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error('编辑器暂不可用，无法导出');
    }

    try {
      const res = await axios.post(`${this.baseUrl}/api/projects/${projectId}/export`, params, { timeout: 300000 });
      return res.data.taskId;
    } catch {
      throw new Error('导出失败');
    }
  }

  async getExportStatus(taskId: string): Promise<any> {
    try {
      const res = await axios.get(`${this.baseUrl}/api/tasks/${taskId}`, { timeout: 10000 });
      return res.data;
    } catch {
      throw new Error('获取导出状态失败');
    }
  }

  async cancelExport(taskId: string): Promise<void> {
    try {
      await axios.post(`${this.baseUrl}/api/tasks/${taskId}/cancel`, {}, { timeout: 10000 });
    } catch {
      // Ignore
    }
  }
}
