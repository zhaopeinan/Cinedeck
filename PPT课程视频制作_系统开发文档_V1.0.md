# 蝉镜 AI PPT 课件配音视频 — 系统开发文档

> 版本：V1.0
>
> 日期：2026-07-18
>
> 目标读者：AI 开发代理、前后端开发工程师
>
> 用途：指导 AI 代理和开发团队按照本文档实施编码，确保实现与 PRD V1.2 一致

---

## 目录

- [1. 系统架构总览](#1-系统架构总览)
- [2. 技术选型](#2-技术选型)
- [3. 目录结构](#3-目录结构)
- [4. 数据模型设计](#4-数据模型设计)
- [5. API 接口设计](#5-api-接口设计)
- [6. 模块详细设计](#6-模块详细设计)
- [7. Voicebox 适配层设计](#7-voicebox-适配层设计)
- [8. OpenCut 适配层设计](#8-opencut-适配层设计)
- [9. 前端页面与组件设计](#9-前端页面与组件设计)
- [10. 状态管理设计](#10-状态管理设计)
- [11. 开发任务拆解与执行顺序](#11-开发任务拆解与执行顺序)
- [12. 关键业务规则速查表](#12-关键业务规则速查表)
- [13. 异常处理规范](#13-异常处理规范)
- [14. 开发约束与注意事项](#14-开发约束与注意事项)

---

## 1. 系统架构总览

### 1.1 架构风格

采用 **前后端分离 + 本地服务** 的混合架构：

- **前端（Browser SPA）**：负责 PPT 导入流程、备注展示、音色选择、配音状态管理、视频预览和 OpenCut 编辑器集成。
- **后端（Node.js / Python 本地服务）**：负责 PPTX 文件解析、备注提取、项目持久化、视频合成调度。
- **Voicebox 本地服务**：独立进程，提供 TTS 音色管理、模型管理、配音生成 REST API。
- **OpenCut 编辑器**：独立前端模块，通过适配层接入，提供时间轴编辑与导出能力。

### 1.2 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器 (SPA)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ PPT导入   │ │ 备注检查  │ │ 音色工作区│ │ 视频预览   │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│       │            │            │              │         │
│  ┌────┴────────────┴────────────┴──────────────┴─────┐  │
│  │              状态管理层 (Store)                      │  │
│  └────┬────────────┬────────────┬──────────────┬─────┘  │
│       │            │            │              │         │
│  ┌────┴─────┐ ┌────┴─────┐ ┌───┴──────┐ ┌────┴──────┐ │
│  │API Client│ │API Client│ │VB Client │ │OC Client  │ │
│  └────┬─────┘ └────┬─────┘ └───┬──────┘ └────┬──────┘ │
└───────┼─────────────┼───────────┼──────────────┼────────┘
        │             │           │              │
   ┌────┴─────┐ ┌─────┴────┐ ┌───┴──────┐ ┌────┴──────┐
   │ 后端API   │ │ 文件解析  │ │ Voicebox │ │ OpenCut   │
   │ 服务      │ │ 服务      │ │ 本地服务  │ │ 编辑器    │
   └────┬─────┘ └─────┬────┘ └───┬──────┘ └───────────┘
        │             │           │
   ┌────┴─────────────┴───────────┴──────┐
   │         本地文件系统 / 数据库          │
   │  PPTX文件 | 音频文件 | 视频文件 | DB   │
   └──────────────────────────────────────┘
```

### 1.3 核心数据流

```
用户上传PPTX → 后端解析(页面+备注) → 前端展示备注列表
→ 用户选择音色/录音建音色 → Voicebox生成配音
→ 后端合成视频(页面画面+音频) → 前端预览
→ 用户进入编辑 → OpenCut编辑项目 → 导出最终视频
```

---

## 2. 技术选型

| 层次 | 技术 | 说明 |
|------|------|------|
| 前端框架 | React 18 + TypeScript | SPA，桌面端优先 |
| UI 组件库 | Ant Design 5 | 企业级组件，表格/表单/弹窗支持完善 |
| 状态管理 | Zustand | 轻量，支持持久化中间件 |
| 路由 | React Router v6 | 页面路由管理 |
| 后端框架 | Node.js + Express / Fastify | 本地服务，处理PPT解析和视频合成 |
| PPT解析 | python-pptx（Python子进程）或 pptxgenjs | 读取页面数量、备注、导出页面图片 |
| 页面渲染 | LibreOffice headless / pptx-to-image | PPT页面转静态图片 |
| 视频合成 | FFmpeg | 页面图片+音频合成视频 |
| 数据存储 | SQLite（better-sqlite3） | 项目元数据、备注、状态持久化 |
| 文件存储 | 本地文件系统 | PPTX、音频、视频文件 |
| 音频服务 | Voicebox（本地REST API） | TTS音色管理、模型管理、配音生成 |
| 编辑器 | OpenCut（嵌入iframe或组件） | 时间轴编辑、导出 |
| 构建工具 | Vite | 前端构建 |

---

## 3. 目录结构

```
PPT_audio/
├── client/                          # 前端项目
│   ├── src/
│   │   ├── api/                     # API客户端
│   │   │   ├── project.ts           # 项目相关API
│   │   │   ├── voicebox.ts          # Voicebox适配API
│   │   │   └── opencut.ts           # OpenCut适配API
│   │   ├── components/              # 通用组件
│   │   │   ├── FileUploader/        # 文件上传组件
│   │   │   ├── AudioPlayer/         # 音频播放组件
│   │   │   ├── VideoPlayer/         # 视频播放组件
│   │   │   ├── ProgressIndicator/   # 进度指示器
│   │   │   └── ConfirmDialog/       # 确认弹窗
│   │   ├── pages/                   # 页面组件
│   │   │   ├── HomePage/            # 首页-导入PPT
│   │   │   ├── NotesCheckPage/      # 备注检查页
│   │   │   ├── VoiceWorkshopPage/   # 音色工作区
│   │   │   ├── DubbingPage/         # 配音生成页
│   │   │   ├── VideoPreviewPage/    # 视频预览页
│   │   │   └── EditorPage/          # OpenCut编辑页
│   │   ├── stores/                  # Zustand状态
│   │   │   ├── projectStore.ts      # 项目状态
│   │   │   ├── voiceStore.ts        # 音色状态
│   │   │   └── editorStore.ts       # 编辑器状态
│   │   ├── hooks/                   # 自定义Hooks
│   │   ├── types/                   # TypeScript类型定义
│   │   │   └── index.ts             # 全局类型
│   │   ├── utils/                   # 工具函数
│   │   ├── constants/               # 常量定义
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
├── server/                          # 后端服务
│   ├── src/
│   │   ├── routes/                  # 路由
│   │   │   ├── project.ts           # 项目路由
│   │   │   ├── parse.ts             # PPT解析路由
│   │   │   ├── video.ts             # 视频合成路由
│   │   │   └── voicebox-proxy.ts    # Voicebox代理路由
│   │   ├── services/                # 业务逻辑
│   │   │   ├── pptParser.ts         # PPT解析服务
│   │   │   ├── videoComposer.ts     # 视频合成服务
│   │   │   ├── projectService.ts    # 项目管理服务
│   │   │   └── voiceboxAdapter.ts   # Voicebox适配层
│   │   ├── db/                      # 数据库
│   │   │   ├── schema.ts            # 表结构定义
│   │   │   └── migrations/          # 数据库迁移
│   │   ├── utils/                   # 工具函数
│   │   └── index.ts                 # 入口
│   ├── tsconfig.json
│   └── package.json
├── shared/                          # 前后端共享
│   └── types/                       # 共享类型定义
│       ├── project.ts               # 项目相关类型
│       ├── voice.ts                 # 音色相关类型
│       └── api.ts                   # API请求/响应类型
├── voicebox/                        # Voicebox本地服务（git submodule或锁定版本）
├── opencut/                         # OpenCut编辑器（git submodule或锁定版本）
├── data/                            # 运行时数据目录
│   ├── projects/                    # 项目数据
│   ├── audio/                       # 音频文件
│   ├── videos/                      # 视频文件
│   └── thumbnails/                  # 页面缩略图
├── reference_system_screenshot/     # 参考截图
├── PPT课程视频制作_PRD_V1.0.md
└── PPT课程视频制作_系统开发文档_V1.0.md
```

---

## 4. 数据模型设计

### 4.1 项目 (Project)

```typescript
interface Project {
  id: string;                       // UUID
  name: string;                     // 项目名称（默认取文件名）
  fileName: string;                 // PPTX文件名
  fileSize: number;                 // 文件大小(bytes)
  filePath: string;                 // PPTX文件存储路径
  parseStatus: ParseStatus;         // 解析状态
  selectedVoiceId: string | null;   // 当前选中的音色ID
  selectedModelId: string | null;   // 当前选中的模型ID
  videoStatus: VideoStatus;         // 视频生成状态
  videoFilePath: string | null;     // 生成的视频文件路径
  allowSilentPages: boolean;        // 是否允许静音页（默认true）
  defaultSilentPageDuration: number;// 静音页默认时长(秒)
  lastSavedAt: string;              // 最后保存时间(ISO8601)
  createdAt: string;                // 创建时间
  updatedAt: string;                // 更新时间
}

enum ParseStatus {
  PENDING = 'pending',             // 待解析
  PARSING = 'parsing',             // 解析中
  SUCCESS = 'success',             // 解析成功
  PARTIAL = 'partial',             // 部分成功
  FAILED = 'failed',               // 解析失败
}

enum VideoStatus {
  NONE = 'none',                   // 未生成
  GENERATING = 'generating',       // 生成中
  SUCCESS = 'success',             // 生成成功
  FAILED = 'failed',               // 生成失败
}
```

### 4.2 页面 (Slide)

```typescript
interface Slide {
  id: string;                       // UUID
  projectId: string;                // 所属项目ID
  pageIndex: number;                // 页面序号(从1开始)
  thumbnailPath: string;            // 缩略图路径
  imagePath: string;                // 页面完整图片路径
  noteStatus: NoteStatus;           // 备注状态
  noteContent: string | null;       // 备注原文
  noteCharCount: number;            // 备注字数
  estimatedDuration: number;        // 预计配音时长(秒)
  dubbingStatus: DubbingStatus;     // 配音状态
  dubbingAudioPath: string | null;  // 配音音频路径
  dubbingDuration: number | null;   // 实际配音时长(秒)
  dubbingVersion: number;           // 配音版本号
  dubbingError: string | null;      // 失败原因
  createdAt: string;
  updatedAt: string;
}

enum NoteStatus {
  LOADED = 'loaded',               // 已读取且有内容
  EMPTY = 'empty',                  // 无备注
  READ_FAILED = 'read_failed',      // 读取失败
  TOO_LONG = 'too_long',           // 内容超出限制
  PAGE_FAILED = 'page_failed',      // 页面读取失败
}

enum DubbingStatus {
  PENDING = 'pending',              // 待生成
  VOICE_PROCESSING = 'voice_processing', // 音色处理中
  MODEL_PREPARING = 'model_preparing',   // 模型准备中
  MODEL_PENDING = 'model_pending',       // 模型待处理
  GENERATING = 'generating',        // 生成中
  GENERATED = 'generated',          // 已生成
  FAILED = 'failed',                // 生成失败
  PLAYING = 'playing',              // 播放中
  REGENERATE_PENDING = 'regenerate_pending', // 待重新生成
}
```

### 4.3 音色档案 (VoiceProfile)

```typescript
interface VoiceProfile {
  id: string;                       // Voicebox音色ID
  name: string;                     // 音色名称
  language: string;                 // 语言代码(zh-CN, en-US等)
  source: VoiceSource;              // 音色来源
  description: string;              // 音色描述
  sampleAudioUrl: string | null;    // 试听样例URL
  isAvailable: boolean;             // 是否可用
  authorizationStatus: AuthStatus;  // 授权状态
  createdAt: string;                // 创建时间
  lastUsedAt: string | null;        // 最近使用时间
}

enum VoiceSource {
  PRESET = 'preset',               // 预置音色
  PERSONAL = 'personal',           // 个人音色
}

enum AuthStatus {
  PENDING = 'pending',             // 待授权
  AUTHORIZED = 'authorized',        // 已授权
  EXPIRED = 'expired',              // 已过期
}
```

### 4.4 配音模型 (DubbingModel)

```typescript
interface DubbingModel {
  id: string;                       // 模型ID
  name: string;                     // 模型名称
  version: string;                  // 版本号
  language: string;                 // 支持语言
  capabilities: string[];           // 能力列表
  downloadSize: number;             // 下载大小(bytes)
  installedSize: number | null;     // 已占用空间(bytes)
  runDevice: string;                // 运行设备(cpu/gpu)
  status: ModelStatus;              // 模型状态
  downloadProgress: number;         // 下载进度(0-100)
  isRecommended: boolean;           // 是否推荐
  recommendReason: string | null;   // 推荐原因
}

enum ModelStatus {
  NOT_DOWNLOADED = 'not_downloaded', // 未下载
  DOWNLOADING = 'downloading',       // 下载中
  DOWNLOADED = 'downloaded',         // 已下载
  LOADING = 'loading',               // 加载中
  AVAILABLE = 'available',           // 可用
  UNAVAILABLE = 'unavailable',       // 不可用
}
```

### 4.5 编辑项目 (EditProject)

```typescript
interface EditProject {
  id: string;                       // 编辑项目ID
  projectId: string;                // 关联的项目ID
  sourceVideoPath: string;          // 原始讲解视频路径
  status: EditStatus;               // 编辑状态
  timeline: TimelineData;           // 时间轴数据
  editVersion: number;              // 编辑版本
  exportStatus: ExportStatus;       // 导出状态
  exportFilePath: string | null;    // 导出文件路径
  createdAt: string;
  updatedAt: string;
}

interface TimelineData {
  tracks: Track[];                   // 轨道列表
  duration: number;                  // 总时长(秒)
}

interface Track {
  id: string;
  type: 'video' | 'audio';          // 轨道类型
  clips: Clip[];                     // 片段列表
}

interface Clip {
  id: string;
  slideIndex: number;                // 关联的PPT页码
  startTime: number;                 // 起始时间(秒)
  endTime: number;                   // 结束时间(秒)
  sourcePath: string;                // 素材文件路径
  duration: number;                  // 片段时长(秒)
  // 音频片段专有
  volume?: number;                   // 音量(0-1)
  fadeIn?: number;                   // 淡入时长(秒)
  fadeOut?: number;                  // 淡出时长(秒)
  muted?: boolean;                   // 是否静音
}

enum EditStatus {
  INITIALIZING = 'initializing',     // 初始化中
  EDITING = 'editing',               // 编辑中
  UNSAVED = 'unsaved',               // 未保存
}

enum ExportStatus {
  NONE = 'none',
  EXPORTING = 'exporting',
  SUCCESS = 'success',
  FAILED = 'failed',
}
```

### 4.6 数据库表结构 (SQLite)

```sql
-- 项目表
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  selected_voice_id TEXT,
  selected_model_id TEXT,
  video_status TEXT NOT NULL DEFAULT 'none',
  video_file_path TEXT,
  allow_silent_pages INTEGER NOT NULL DEFAULT 1,
  default_silent_page_duration REAL NOT NULL DEFAULT 5.0,
  last_saved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 页面表
CREATE TABLE slides (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  thumbnail_path TEXT,
  image_path TEXT,
  note_status TEXT NOT NULL DEFAULT 'loaded',
  note_content TEXT,
  note_char_count INTEGER DEFAULT 0,
  estimated_duration REAL DEFAULT 0,
  dubbing_status TEXT NOT NULL DEFAULT 'pending',
  dubbing_audio_path TEXT,
  dubbing_duration REAL,
  dubbing_version INTEGER DEFAULT 0,
  dubbing_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, page_index)
);

-- 编辑项目表
CREATE TABLE edit_projects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_video_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initializing',
  timeline TEXT,  -- JSON存储
  edit_version INTEGER DEFAULT 1,
  export_status TEXT NOT NULL DEFAULT 'none',
  export_file_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 5. API 接口设计

### 5.1 后端API基础

- 基础路径：`/api/v1`
- 响应格式：

```typescript
interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: {
    code: string;
    message: string;
    details?: unknown;
  } | null;
}
```

### 5.2 项目管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/projects` | 创建项目（上传PPTX） |
| GET | `/api/v1/projects/:id` | 获取项目详情 |
| PUT | `/api/v1/projects/:id` | 更新项目配置 |
| DELETE | `/api/v1/projects/:id` | 删除项目 |
| GET | `/api/v1/projects` | 项目列表 |

### 5.3 PPT解析 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/projects/:id/parse` | 触发PPT解析 |
| GET | `/api/v1/projects/:id/slides` | 获取页面列表与备注 |
| POST | `/api/v1/projects/:id/slides/:pageIndex/reparse` | 重新解析单页备注 |
| GET | `/api/v1/projects/:id/slides/:pageIndex/image` | 获取页面图片 |
| GET | `/api/v1/projects/:id/slides/:pageIndex/thumbnail` | 获取页面缩略图 |

### 5.4 音色与模型 API（Voicebox代理）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/voicebox/health` | Voicebox健康检查 |
| GET | `/api/v1/voicebox/voices` | 获取音色列表 |
| POST | `/api/v1/voicebox/voices` | 创建个人音色 |
| GET | `/api/v1/voicebox/voices/:id` | 获取音色详情 |
| DELETE | `/api/v1/voicebox/voices/:id` | 删除音色 |
| GET | `/api/v1/voicebox/voices/:id/sample` | 获取音色试听 |
| POST | `/api/v1/voicebox/record/start` | 开始录音 |
| POST | `/api/v1/voicebox/record/stop` | 停止录音 |
| POST | `/api/v1/voicebox/record/quality-check` | 录音质量检查 |
| GET | `/api/v1/voicebox/models` | 获取模型列表 |
| POST | `/api/v1/voicebox/models/:id/download` | 开始下载模型 |
| POST | `/api/v1/voicebox/models/:id/download/pause` | 暂停下载 |
| POST | `/api/v1/voicebox/models/:id/download/resume` | 继续下载 |
| POST | `/api/v1/voicebox/models/:id/download/cancel` | 取消下载 |
| DELETE | `/api/v1/voicebox/models/:id` | 删除模型 |
| GET | `/api/v1/voicebox/models/:id/status` | 获取模型状态 |

### 5.5 配音生成 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/projects/:id/dubbing/generate` | 按备注生成全部配音 |
| POST | `/api/v1/projects/:id/dubbing/generate/:pageIndex` | 生成单页配音 |
| GET | `/api/v1/projects/:id/dubbing/status` | 获取配音整体状态 |
| POST | `/api/v1/projects/:id/dubbing/cancel` | 取消配音生成 |
| GET | `/api/v1/projects/:id/slides/:pageIndex/audio` | 获取页面配音音频 |

### 5.6 视频合成 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/projects/:id/video/compose` | 合成讲解视频 |
| GET | `/api/v1/projects/:id/video/status` | 获取视频合成状态 |
| GET | `/api/v1/projects/:id/video/play` | 获取视频播放地址 |
| POST | `/api/v1/projects/:id/video/retry` | 重试视频合成 |

### 5.7 OpenCut编辑 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/projects/:id/opencut/init` | 创建编辑项目 |
| GET | `/api/v1/projects/:id/opencut/project` | 获取编辑项目 |
| PUT | `/api/v1/projects/:id/opencut/timeline` | 更新时间轴 |
| POST | `/api/v1/projects/:id/opencut/export` | 导出最终视频 |
| GET | `/api/v1/projects/:id/opencut/export/status` | 导出状态 |
| POST | `/api/v1/projects/:id/opencut/export/retry` | 重试导出 |

### 5.8 自动保存 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/projects/:id/autosave` | 触发自动保存 |
| GET | `/api/v1/projects/:id/autosave/status` | 获取保存状态 |

---

## 6. 模块详细设计

### 6.1 PPTX 导入与解析模块

#### 职责
- 接收PPTX文件上传
- 校验文件格式、大小和可读性
- 解析PPT页面数量、页面图片和演讲者备注
- 导出页面静态图片

#### 核心逻辑

```typescript
// server/src/services/pptParser.ts

interface ParseResult {
  totalPages: number;
  slides: SlideParseResult[];
  parseStatus: ParseStatus;
  errors: ParseError[];
}

interface SlideParseResult {
  pageIndex: number;
  imagePath: string;
  thumbnailPath: string;
  noteStatus: NoteStatus;
  noteContent: string | null;
  noteCharCount: number;
  estimatedDuration: number;  // 按 noteCharCount * 语速系数 估算
  error?: string;
}

interface ParseError {
  pageIndex: number;
  type: 'page_failed' | 'read_failed' | 'too_long';
  message: string;
}

// 解析流程：
// 1. 校验文件扩展名 === '.pptx'
// 2. 校验文件可读取性（尝试打开）
// 3. 逐页提取：
//    a. 页面图片导出（LibreOffice headless: pptx → PNG）
//    b. 备注提取（python-pptx: slide.notes_slide.notes_text_frame.text）
//    c. 备注状态判定：有内容→LOADED，空→EMPTY，异常→READ_FAILED
// 4. 生成缩略图（图片缩放至统一尺寸）
// 5. 计算预计配音时长（字数 × 语速系数，中文约 4字/秒）
// 6. 返回 ParseResult
```

#### 校验规则
- 文件扩展名必须为 `.pptx`
- 文件大小不超过上限值（待确认，暂定 200MB）
- 页面数量不超过上限值（待确认，暂定 200页）
- 单页备注字数不超过上限值（待确认，暂定 10000字）

### 6.2 备注管理模块

#### 职责
- 展示页面备注列表
- 管理备注状态（筛选、重新读取）
- 控制生成权限（有失败页时禁止生成）

#### 业务规则实现

```typescript
// 判断是否允许进入配音步骤
function canProceedToDubbing(slides: Slide[]): { allowed: boolean; reason?: string } {
  const hasReadFail = slides.some(s =>
    s.noteStatus === NoteStatus.READ_FAILED ||
    s.noteStatus === NoteStatus.PAGE_FAILED ||
    s.noteStatus === NoteStatus.TOO_LONG
  );
  if (hasReadFail) {
    return { allowed: false, reason: '存在备注读取失败的页面，请处理后再继续' };
  }
  const hasNotes = slides.some(s => s.noteStatus === NoteStatus.LOADED);
  if (!hasNotes) {
    return { allowed: false, reason: '未读取到PPT备注，请在原PPT中添加备注后重新导入' };
  }
  return { allowed: true };
}

// 判断是否允许生成视频
function canComposeVideo(project: Project, slides: Slide[]): { allowed: boolean; reason?: string } {
  // 1. PPT页面解析全部成功
  if (project.parseStatus !== ParseStatus.SUCCESS && project.parseStatus !== ParseStatus.PARTIAL) {
    return { allowed: false, reason: 'PPT解析未完成' };
  }
  // 2. 备注读取不存在失败页
  const hasFailedNotes = slides.some(s =>
    s.noteStatus === NoteStatus.READ_FAILED ||
    s.noteStatus === NoteStatus.PAGE_FAILED ||
    s.noteStatus === NoteStatus.TOO_LONG
  );
  if (hasFailedNotes) {
    return { allowed: false, reason: '存在备注读取失败的页面' };
  }
  // 3. 已选择音色
  if (!project.selectedVoiceId) {
    return { allowed: false, reason: '请先选择配音音色' };
  }
  // 4. 所有有备注页面配音状态为 GENERATED
  const hasNotesPages = slides.filter(s => s.noteStatus === NoteStatus.LOADED);
  const allDubbed = hasNotesPages.every(s => s.dubbingStatus === DubbingStatus.GENERATED);
  if (!allDubbed) {
    return { allowed: false, reason: '存在未完成配音的页面' };
  }
  // 5. 静音页规则
  const silentPages = slides.filter(s => s.noteStatus === NoteStatus.EMPTY);
  if (!project.allowSilentPages && silentPages.length > 0) {
    return { allowed: false, reason: `存在${silentPages.length}页无备注页面，请补充备注或允许静音页` };
  }
  return { allowed: true };
}
```

### 6.3 Voicebox 适配层模块

详见 [第7节](#7-voicebox-适配层设计)。

### 6.4 配音生成模块

#### 职责
- 接收生成请求，按页面顺序调度Voicebox TTS
- 管理生成任务状态
- 处理单页失败重试
- 生成完成后触发视频合成

#### 核心流程

```
1. 前端点击"按备注生成配音"
2. 前端校验：音色已选 + 模型可用 + 无失败备注页
3. POST /api/v1/projects/:id/dubbing/generate
4. 后端逻辑：
   a. 再次校验音色档案和模型状态
   b. 获取所有有备注页面的备注原文
   c. 按页面顺序逐页调用 Voicebox TTS
   d. 每页完成后更新 Slide.dubbingStatus 和 dubbingDuration
   e. 全部完成后自动触发视频合成
5. 前端轮询 GET /api/v1/projects/:id/dubbing/status 获取进度
```

#### 配音原文保障规则
- 生成文本必须等于备注读取结果
- **禁止**自动改写、润色、扩写、删减
- 系统必须记录每页使用的备注原文、音色、模型和生成版本

### 6.5 视频合成模块

#### 职责
- 将PPT页面图片与对应配音音频合成为自动翻页讲解视频
- 同时生成 OpenCut 所需的素材包和时间轴映射

#### 核心逻辑

```typescript
// server/src/services/videoComposer.ts

interface ComposeInput {
  projectId: string;
  slides: Slide[];           // 按pageIndex排序
  allowSilentPages: boolean;
  defaultSilentPageDuration: number; // 静音页默认时长(秒)
}

interface ComposeResult {
  videoPath: string;         // 可播放的MP4文件
  openCutProject: {          // OpenCut素材包
    slides: SlideAsset[];
    audios: AudioAsset[];
    timeline: TimelineMapping;
  };
}

// 合成流程（FFmpeg）：
// 1. 准备素材清单：按pageIndex排序
// 2. 为每页计算展示时长：
//    - 有配音页：dubbingDuration（音频实际时长）
//    - 无备注页：defaultSilentPageDuration
// 3. 生成FFmpeg concat文件：
//    每页：图片 + 对应音频 → 临时片段视频
//    注意：音频结束后才切页，不提前截断
// 4. FFmpeg concat所有片段 → 最终MP4
// 5. 同时生成OpenCut素材包：
//    - 页面图片列表
//    - 音频文件列表
//    - 时间轴映射（页码 → 起止时间）
// 6. 返回 ComposeResult
```

#### 合成约束
- 页面切换点必须在音频播放完成后
- 页面切换不得出现黑帧或空白帧
- 合成必须同时输出可播放视频和OpenCut素材包

### 6.6 OpenCut 编辑模块

详见 [第8节](#8-opencut-适配层设计)。

### 6.7 项目保存模块

#### 职责
- 自动保存项目状态
- 恢复上次保存状态

#### 保存策略
- 用户停止操作 1 秒后触发自动保存（前端 debounce）
- 保存内容：项目配置、页面备注状态、音色选择、配音状态、视频生成状态、编辑项目引用
- 保存失败时前端显示"保存失败"，不清除当前数据
- 网络恢复后自动重试

---

## 7. Voicebox 适配层设计

### 7.1 设计原则

- **隔离性**：产品代码不直接依赖 Voicebox 的 TTS 引擎字段，通过适配层统一映射
- **版本锁定**：锁定 Voicebox 的特定发布版本或提交号，不依赖 main 分支
- **可替换性**：适配层接口稳定，底层可替换 TTS 引擎

### 7.2 适配层接口

```typescript
// server/src/services/voiceboxAdapter.ts

interface VoiceboxAdapter {
  // 健康检查
  healthCheck(): Promise<{ available: boolean; version: string }>;

  // 音色管理
  listVoices(filter?: { language?: string }): Promise<VoiceProfile[]>;
  getVoice(voiceId: string): Promise<VoiceProfile>;
  createVoice(params: CreateVoiceParams): Promise<VoiceProfile>;
  deleteVoice(voiceId: string): Promise<void>;
  getVoiceSample(voiceId: string): Promise<string>; // 返回音频URL

  // 录音
  startRecording(params: { voiceName: string; language: string }): Promise<{ sessionId: string }>;
  stopRecording(sessionId: string): Promise<{ audioPath: string; duration: number }>;
  checkRecordingQuality(audioPath: string): Promise<QualityCheckResult>;

  // 模型管理
  listModels(filter?: { language?: string }): Promise<DubbingModel[]>;
  downloadModel(modelId: string): Promise<void>;
  pauseModelDownload(modelId: string): Promise<void>;
  resumeModelDownload(modelId: string): Promise<void>;
  cancelModelDownload(modelId: string): Promise<void>;
  deleteModel(modelId: string): Promise<void>;
  getModelStatus(modelId: string): Promise<DubbingModel>;

  // 配音生成
  generateDubbing(params: {
    text: string;
    voiceId: string;
    modelId: string;
    language: string;
  }): Promise<GenerateTask>;

  // 任务管理
  getTaskStatus(taskId: string): Promise<GenerateTask>;
  cancelTask(taskId: string): Promise<void>;
  getTaskResult(taskId: string): Promise<{ audioPath: string; duration: number }>;
}

interface CreateVoiceParams {
  name: string;
  language: string;
  description?: string;
  recordingPath: string;
  authorize: boolean;
}

interface QualityCheckResult {
  passed: boolean;
  issues: QualityIssue[];
}

interface QualityIssue {
  type: 'no_audio' | 'too_short' | 'too_low_volume' | 'persistent_noise' | 'corrupt_file';
  message: string;
}

interface GenerateTask {
  id: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;       // 0-100
  error?: string;
  result?: {
    audioPath: string;
    duration: number;
  };
}
```

### 7.3 Voicebox API 映射

以下为业务接口到 Voicebox REST API 的映射，**具体路径以锁定版本为准**：

| 业务接口 | Voicebox API（示例路径） | 说明 |
|----------|-------------------------|------|
| 健康检查 | `GET /api/health` | 返回服务状态和版本 |
| 音色列表 | `GET /api/voices` | 返回音色档案列表 |
| 创建音色 | `POST /api/voices` | 提交录音文件创建音色 |
| 删除音色 | `DELETE /api/voices/:id` | 删除音色档案 |
| 音色试听 | `GET /api/voices/:id/sample` | 返回试听音频 |
| 模型列表 | `GET /api/models` | 返回可用模型 |
| 下载模型 | `POST /api/models/:id/download` | 触发下载 |
| 生成配音 | `POST /api/tts/generate` | 提交文本+音色+模型 |
| 任务状态 | `GET /api/tasks/:id` | 查询生成任务 |

### 7.4 长文本处理

- 优先使用 Voicebox 内置的句子切分和交叉淡化能力
- 产品必须验证：分段边界不丢字、不重复
- 中文标点和英文缩写不被错误切分
- 单页最大字数和分段上限在接入测试中确定

---

## 8. OpenCut 适配层设计

### 8.1 设计原则

- **版本锁定**：锁定 OpenCut 特定提交或受控分支
- **降级可用**：OpenCut 不可用时仍保留视频预览
- **数据隔离**：编辑变更不反写原始PPT、备注和Voicebox音频
- **可替换性**：适配层保证编辑器可替换

### 8.2 适配层接口

```typescript
// server/src/services/opencutAdapter.ts

interface OpenCutAdapter {
  // 初始化
  initProject(params: InitProjectParams): Promise<OpenCutProject>;

  // 时间轴操作
  getTimeline(projectId: string): Promise<TimelineData>;
  updateTimeline(projectId: string, timeline: TimelineData): Promise<TimelineData>;

  // 预览
  getPreviewUrl(projectId: string): Promise<string>;

  // 导出
  startExport(projectId: string, params: ExportParams): Promise<string>; // taskId
  getExportStatus(taskId: string): Promise<ExportStatus>;
  cancelExport(taskId: string): Promise<void>;

  // 健康检查
  isAvailable(): Promise<boolean>;
}

interface InitProjectParams {
  slides: {
    pageIndex: number;
    imagePath: string;
    duration: number;      // 展示时长
  }[];
  audios: {
    pageIndex: number;
    audioPath: string;
    duration: number;
  }[];
  aspectRatio: string;     // 视频画面比例，如 '16:9'
}

interface ExportParams {
  format: 'mp4';           // 默认MP4
  resolution?: string;     // 分辨率
  frameRate?: number;      // 帧率
}

interface OpenCutProject {
  id: string;
  status: 'initializing' | 'ready' | 'error';
  timeline: TimelineData | null;
  error?: string;
}
```

### 8.3 最小编辑能力清单

以下为 OpenCut 必须支持的最小编辑操作，适配层必须逐一验证：

- 播放/暂停
- 播放头拖动
- 时间轴缩放
- 页面片段：选择、移动、时长调整、删除、复制、排序
- 音频片段：选择、裁剪、分割、音量调整、静音、淡入淡出
- 撤销和重做

### 8.4 降级策略

```typescript
async function enterEditor(projectId: string): Promise<{ mode: 'editor' | 'fallback'; reason?: string }> {
  const adapter = getOpenCutAdapter();
  const available = await adapter.isAvailable();
  if (!available) {
    return { mode: 'fallback', reason: '编辑器暂不可用' };
  }
  try {
    await adapter.initProject(/* ... */);
    return { mode: 'editor' };
  } catch (error) {
    return { mode: 'fallback', reason: '编辑器初始化失败' };
  }
}
```

---

## 9. 前端页面与组件设计

### 9.1 页面路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | HomePage | 首页-导入PPT |
| `/project/:id/notes` | NotesCheckPage | 备注检查页 |
| `/project/:id/voice` | VoiceWorkshopPage | 音色工作区 |
| `/project/:id/dubbing` | DubbingPage | 配音生成与试听 |
| `/project/:id/preview` | VideoPreviewPage | 视频预览页 |
| `/project/:id/editor` | EditorPage | OpenCut编辑页 |

### 9.2 步骤条组件

页面顶部显示步骤进度：

```
导入PPT → 读取备注 → 选择音色并生成配音 → 视频预览 → 编辑导出
```

每步根据项目当前状态自动高亮和跳转。

### 9.3 关键页面组件

#### HomePage
- `FileUploader`：PPTX文件上传卡片，展示文件名、大小、校验状态
- `ParseButton`：读取PPT备注按钮

#### NotesCheckPage
- `NotesList`：页面备注列表，按页面序号展示
  - 每项：页码、缩略图、备注状态标签、字数、预计时长
  - 支持筛选：全部/已读取/无备注/读取失败
- `NoteDetail`：点击缩略图展开完整备注和页面画面
- `ReparseButton`：重新读取备注

#### VoiceWorkshopPage
- `VoiceSelector`：音色选择卡片列表
  - 每项：音色名称、语言、试听按钮、选中态
- `VoiceRecorder`：录音弹窗
  - 录音控制：开始/暂停/继续/停止
  - 实时显示：录音时长、输入音量、麦克风状态
  - 质量检查结果展示
  - 保存表单：名称、语言、描述
- `ModelManager`：模型列表与下载管理
  - 每项：名称、版本、语言、大小、状态、下载/删除操作
  - 下载进度条：进度、速度、剩余空间、剩余时间
- `VoiceProfileManager`：个人音色档案管理

#### DubbingPage
- `DubbingGenerator`：按备注生成配音按钮+进度
- `SlideAudioList`：页面配音状态列表
  - 每项：页码、备注摘要、配音状态、时长、播放/试听按钮
- `AudioPlayer`：单页播放器
- `FullPreviewPlayer`：全片试听播放器

#### VideoPreviewPage
- `VideoPlayer`：讲解视频播放器
  - 当前页码、播放时间、总时长
- `EnterEditorButton`：进入编辑按钮
- `RetryComposeButton`：重新生成视频

#### EditorPage
- `OpenCutEditor`：嵌入OpenCut编辑器（iframe或组件）
- `ExportPanel`：导出控制面板
  - 导出按钮、进度、取消

### 9.4 通用交互组件

| 组件 | 用途 |
|------|------|
| `ConfirmDialog` | 覆盖确认、删除确认、离开确认 |
| `ProgressIndicator` | 解析进度、下载进度、合成进度 |
| `StatusBadge` | 备注状态、配音状态、模型状态标签 |
| `Toast` | 轻提示（音量过低、保存状态等） |
| `EmptyState` | 无备注、音色列表为空等空状态 |

---

## 10. 状态管理设计

### 10.1 Store 结构

```typescript
// stores/projectStore.ts
interface ProjectStore {
  // 项目数据
  currentProject: Project | null;
  slides: Slide[];
  isParsing: boolean;
  isComposing: boolean;

  // 操作
  createProject: (file: File) => Promise<Project>;
  parseProject: (projectId: string) => Promise<void>;
  updateProject: (projectId: string, updates: Partial<Project>) => Promise<void>;
  reimportProject: (projectId: string, file: File) => Promise<void>;

  // 配音
  startDubbing: (projectId: string) => Promise<void>;
  retryDubbing: (projectId: string, pageIndex: number) => Promise<void>;

  // 视频
  composeVideo: (projectId: string) => Promise<void>;
  retryCompose: (projectId: string) => Promise<void>;

  // 试听
  currentPlayingPageIndex: number | null;
  isFullPreview: boolean;
  playPage: (pageIndex: number) => void;
  playFullPreview: () => void;
  stopPlayback: () => void;
}

// stores/voiceStore.ts
interface VoiceStore {
  voices: VoiceProfile[];
  selectedVoiceId: string | null;
  models: DubbingModel[];
  selectedModelId: string | null;

  // 录音状态
  isRecording: boolean;
  recordingDuration: number;
  recordingVolume: number;

  // 操作
  loadVoices: () => Promise<void>;
  selectVoice: (voiceId: string) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  checkRecordingQuality: () => Promise<QualityCheckResult>;
  saveVoiceProfile: (params: CreateVoiceParams) => Promise<VoiceProfile>;
  deleteVoiceProfile: (voiceId: string) => Promise<void>;

  // 模型
  loadModels: () => Promise<void>;
  selectModel: (modelId: string) => void;
  downloadModel: (modelId: string) => Promise<void>;
  pauseModelDownload: (modelId: string) => Promise<void>;
  cancelModelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
}

// stores/editorStore.ts
interface EditorStore {
  editProject: EditProject | null;
  isInitializing: boolean;
  isExporting: boolean;
  exportProgress: number;

  // 操作
  initEditor: (projectId: string) => Promise<void>;
  updateTimeline: (timeline: TimelineData) => Promise<void>;
  startExport: (projectId: string, params: ExportParams) => Promise<void>;
  retryExport: (projectId: string) => Promise<void>;
}
```

### 10.2 自动保存

```typescript
// 前端 debounce 自动保存
const useAutoSave = (projectId: string) => {
  const { currentProject, slides } = useProjectStore();
  const { selectedVoiceId, selectedModelId } = useVoiceStore();

  useEffect(() => {
    const timer = setTimeout(() => {
      api.autosave(projectId, {
        project: currentProject,
        slides,
        selectedVoiceId,
        selectedModelId,
      });
    }, 1000); // 停止操作1秒后触发

    return () => clearTimeout(timer);
  }, [currentProject, slides, selectedVoiceId, selectedModelId]);
};
```

---

## 11. 开发任务拆解与执行顺序

### Phase 1：基础框架搭建（优先级：最高）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T1.1 | 初始化前后端项目结构 | 无 | client/ + server/ 目录 |
| T1.2 | 配置 Vite + React + TypeScript + Ant Design | T1.1 | 可运行的前端空壳 |
| T1.3 | 配置 Node.js 后端 + SQLite | T1.1 | 可运行的后端空壳 |
| T1.4 | 定义共享类型 shared/types | T1.1 | TypeScript 类型文件 |
| T1.5 | 创建数据库 Schema 和迁移 | T1.3 | 数据库表 |
| T1.6 | 搭建前端路由和步骤条 | T1.2 | 页面路由框架 |

### Phase 2：PPT 导入与解析（优先级：高）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T2.1 | 实现文件上传 API + 文件校验 | T1.3 | POST /api/v1/projects |
| T2.2 | 实现 PPT 解析服务（页面+备注提取） | T2.1 | pptParser.ts |
| T2.3 | 实现页面图片导出（PPT→PNG） | T2.1 | LibreOffice/pptx-to-image集成 |
| T2.4 | 实现缩略图生成 | T2.3 | 图片缩放服务 |
| T2.5 | 实现首页 FileUploader 组件 | T1.6 | HomePage |
| T2.6 | 实现备注检查页 NotesList 组件 | T1.6 | NotesCheckPage |
| T2.7 | 实现备注状态筛选和详情展示 | T2.6 | 筛选+详情弹窗 |
| T2.8 | 实现重新读取备注功能 | T2.2, T2.6 | 重新解析接口+UI |

### Phase 3：Voicebox 适配层（优先级：高）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T3.1 | 部署并锁定 Voicebox 版本 | T1.3 | Voicebox本地服务 |
| T3.2 | 实现 VoiceboxAdapter 核心接口 | T3.1 | voiceboxAdapter.ts |
| T3.3 | 实现健康检查和音色列表 API | T3.2 | 代理路由 |
| T3.4 | 实现录音功能 API | T3.2 | 录音控制接口 |
| T3.5 | 实现录音质量检查 | T3.4 | qualityCheck逻辑 |
| T3.6 | 实现模型管理 API | T3.2 | 模型CRUD接口 |
| T3.7 | 实现配音生成 API | T3.2 | TTS调用接口 |

### Phase 4：音色工作区前端（优先级：高）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T4.1 | 实现 VoiceSelector 音色选择组件 | T3.3, T1.6 | 音色卡片列表 |
| T4.2 | 实现 VoiceRecorder 录音弹窗组件 | T3.4, T4.1 | 录音弹窗 |
| T4.3 | 实现录音质量检查展示 | T3.5, T4.2 | 质量检查UI |
| T4.4 | 实现 VoiceProfileManager 音色档案管理 | T4.1 | 档案列表+删除 |
| T4.5 | 实现 ModelManager 模型管理组件 | T3.6, T4.1 | 模型列表+下载 |
| T4.6 | 实现 VoiceWorkshopPage 整合 | T4.1-T4.5 | 音色工作区页面 |

### Phase 5：配音生成（优先级：高）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T5.1 | 实现配音生成后端逻辑 | T3.7, T2.2 | 逐页生成+状态管理 |
| T5.2 | 实现生成前校验逻辑 | T5.1 | canComposeVideo校验 |
| T5.3 | 实现 DubbingPage 页面 | T5.1, T4.6 | 配音生成页 |
| T5.4 | 实现单页试听播放器 | T5.3 | AudioPlayer组件 |
| T5.5 | 实现全片试听播放器 | T5.4 | 全片播放逻辑 |
| T5.6 | 实现配音失败重试 | T5.1 | 单页重试功能 |
| T5.7 | 实现音色切换时重新生成标记 | T5.3 | 状态联动 |

### Phase 6：视频合成（优先级：中）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T6.1 | 实现 FFmpeg 视频合成服务 | T5.1 | videoComposer.ts |
| T6.2 | 实现自动翻页合成逻辑 | T6.1 | 按音频时长切页 |
| T6.3 | 实现 OpenCut 素材包生成 | T6.1 | 时间轴映射JSON |
| T6.4 | 实现 VideoPreviewPage | T6.2, T5.3 | 视频预览页 |
| T6.5 | 实现合成进度展示 | T6.2 | 进度条组件 |
| T6.6 | 实现合成失败重试 | T6.1 | 重试逻辑 |

### Phase 7：OpenCut 编辑集成（优先级：中）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T7.1 | 部署并锁定 OpenCut 版本 | T1.3 | OpenCut编辑器 |
| T7.2 | 实现 OpenCutAdapter 接口 | T7.1 | opencutAdapter.ts |
| T7.3 | 实现编辑项目初始化 | T7.2 | 导入素材+时间轴 |
| T7.4 | 实现 EditorPage 嵌入编辑器 | T7.2 | 编辑器页面 |
| T7.5 | 实现编辑降级策略 | T7.2 | 不可用时回退视频预览 |
| T7.6 | 实现导出功能 | T7.2 | 导出API+UI |
| T7.7 | 实现导出失败重试 | T7.6 | 重试逻辑 |

### Phase 8：项目保存与完善（优先级：中）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T8.1 | 实现自动保存后端 | T1.3 | autosave API |
| T8.2 | 实现自动保存前端 debounce | T8.1 | useAutoSave hook |
| T8.3 | 实现项目恢复 | T8.1 | 页面加载时恢复状态 |
| T8.4 | 实现重新导入覆盖确认 | T2.5 | ConfirmDialog |
| T8.5 | 全链路联调测试 | T5-T7 | 端到端流程验证 |

### Phase 9：数据埋点（优先级：低）

| 任务ID | 任务 | 依赖 | 产出 |
|--------|------|------|------|
| T9.1 | 实现埋点 SDK 封装 | T8.5 | 通用埋点模块 |
| T9.2 | 按PRD埋点表逐项接入 | T9.1 | 全部事件埋点 |

---

## 12. 关键业务规则速查表

| 编号 | 规则 | 实现要点 |
|------|------|----------|
| R1 | PPT页面是视频画面唯一来源 | 不修改原页面内容，直接使用PPT导出的页面图片 |
| R2 | 备注是配音文本唯一来源 | 不自动补写/改写/扩写备注；TTS输入严格等于noteContent |
| R3 | 备注按页面序号关联 | 第N页只用第N页备注，空备注不导致后续错位 |
| R4 | 音色为项目级配置 | 一个项目一个音色，应用于全部有备注页面 |
| R5 | 无备注页面默认保留 | 标记为静音页，使用defaultSilentPageDuration |
| R6 | 有备注页展示时长=音频时长 | 音频结束后才切页，不提前截断 |
| R7 | 备注读取失败必须显示 | 不能静默当作无备注，必须阻止生成 |
| R8 | 音色切换后旧音频标记待重新生成 | 不自动使用旧音频冒充新音色 |
| R9 | 编辑变更不反写原始数据 | OpenCut编辑不影响PPT、备注和Voicebox原始音频 |
| R10 | 模型未准备好时阻止生成 | 检查模型已下载、完整、加载且兼容 |
| R11 | 视频合成同时输出两个结果 | 可播放视频 + OpenCut素材包，缺一不可 |
| R12 | 页面切换无黑帧 | FFmpeg合成确保帧连续，不出现空白帧 |

---

## 13. 异常处理规范

### 13.1 前端错误展示

```typescript
// 统一错误处理
interface AppError {
  code: string;           // 错误码
  message: string;        // 用户可见文案
  details?: unknown;      // 调试信息
  recoverable: boolean;   // 是否可恢复
  action?: {              // 建议操作
    label: string;
    handler: () => void;
  };
}

// 错误码规范
const ErrorCodes = {
  // 文件相关 1xxx
  FILE_NOT_PPTX: { code: '1001', message: '仅支持PPTX文件，请重新选择' },
  FILE_CORRUPT: { code: '1002', message: '文件无法读取，请检查文件后重试' },
  FILE_TOO_LARGE: { code: '1003', message: '文件超出大小限制' },
  FILE_NETWORK_ERROR: { code: '1004', message: '网络异常，请检查网络后重试' },

  // 解析相关 2xxx
  PARSE_PAGE_FAILED: { code: '2001', message: '页面读取失败' },
  PARSE_NOTE_FAILED: { code: '2002', message: '备注读取失败' },
  PARSE_NOTE_TOO_LONG: { code: '2003', message: '内容超出限制' },
  PARSE_NO_NOTES: { code: '2004', message: '未读取到PPT备注' },

  // 音色相关 3xxx
  VOICE_LOAD_FAILED: { code: '3001', message: '音色加载失败' },
  VOICE_UNAVAILABLE: { code: '3002', message: '音色不可用' },
  VOICE_SAMPLE_FAILED: { code: '3003', message: '试听失败，请重试' },
  VOICE_MIC_DENIED: { code: '3004', message: '麦克风权限被拒绝' },
  VOICE_MIC_DISCONNECTED: { code: '3005', message: '录音设备断开' },
  VOICE_RECORD_QUALITY: { code: '3006', message: '录音质量不合格' },

  // 模型相关 4xxx
  MODEL_NOT_READY: { code: '4001', message: '配音模型未准备好' },
  MODEL_INCOMPATIBLE: { code: '4002', message: '模型与音色不兼容' },
  MODEL_DOWNLOAD_FAILED: { code: '4003', message: '模型下载失败' },
  MODEL_LOAD_FAILED: { code: '4004', message: '模型加载失败' },
  MODEL_DISK_FULL: { code: '4005', message: '磁盘空间不足' },

  // 配音相关 5xxx
  DUBBING_TTS_TIMEOUT: { code: '5001', message: '配音生成超时' },
  DUBBING_TTS_FAILED: { code: '5002', message: '配音生成失败' },
  DUBBING_SERVICE_DOWN: { code: '5003', message: '音频服务不可用' },

  // 视频相关 6xxx
  VIDEO_COMPOSE_FAILED: { code: '6001', message: '视频合成失败' },

  // 编辑器相关 7xxx
  EDITOR_UNAVAILABLE: { code: '7001', message: '编辑器暂不可用' },
  EDITOR_INIT_FAILED: { code: '7002', message: '编辑器初始化失败' },
  EXPORT_FAILED: { code: '7003', message: '视频导出失败' },

  // 保存相关 8xxx
  SAVE_FAILED: { code: '8001', message: '保存失败，请检查网络' },
};
```

### 13.2 超时策略

| 场景 | 显示时机 | 超时阈值 | 处理 |
|------|----------|----------|------|
| 文件校验 | 即时返回 | - | 网络异常可重试 |
| 备注读取 | 8秒无响应 | 总超时待确认 | 显示"仍在读取备注"，超时后提供重试 |
| 配音生成 | 8秒无响应 | 任务级超时待确认 | 显示"处理中"，超时后标记失败 |
| 视频合成 | 即时进度 | - | 显示页码和进度 |
| 模型下载 | 即时进度 | - | 支持暂停/继续/取消 |
| 导出 | 即时进度 | - | 显示阶段和进度 |

---

## 14. 开发约束与注意事项

### 14.1 AI开发代理必读

1. **严格按照本文档的数据模型和API设计开发**，不得自行添加或修改字段。
2. **业务规则以第12节速查表为准**，遇到PRD与本文档不一致时以本文档为准（因为本文档是对PRD的工程化转译）。
3. **所有"待确认"参数**：实现时使用常量定义在 `constants/` 目录，便于后续修改：
   ```typescript
   // constants/config.ts
   export const APP_CONFIG = {
     MAX_FILE_SIZE: 200 * 1024 * 1024,        // 200MB，待确认
     MAX_PAGE_COUNT: 200,                       // 待确认
     MAX_NOTE_CHAR_COUNT: 10000,                // 待确认
     DEFAULT_SILENT_PAGE_DURATION: 5,           // 秒，待确认
     SPEECH_RATE_ZH: 4,                         // 中文字/秒，估算用
     AUTOSAVE_DEBOUNCE_MS: 1000,                // 自动保存延迟
     PARSE_TIMEOUT_MS: 30000,                   // 解析超时，待确认
     DUBBING_TASK_TIMEOUT_MS: 60000,            // 单页配音超时，待确认
   };
   ```
4. **Voicebox和OpenCut必须锁定版本**，不得使用main分支。版本号记录在项目根目录 `dependencies.lock.json` 中：
   ```json
   {
     "voicebox": {
       "repo": "https://github.com/jamiepine/voicebox",
       "version": "待接入时锁定",
       "commit": "待接入时锁定",
       "license": "MIT"
     },
     "opencut": {
       "repo": "https://github.com/OpenCut-app/OpenCut",
       "version": "待接入时锁定",
       "commit": "待接入时锁定",
       "license": "MIT"
     }
   }
   ```
5. **配音原文保障**：TTS调用时传入的text参数必须严格等于Slide.noteContent，不得做任何变换。

### 14.2 安全与隐私

- 个人录音文件默认保存在本地Voicebox数据目录
- 未确认的录音不得上传或加入公共音色列表
- 录音前必须展示用途说明和授权确认
- 必须提供数据删除和本地缓存清理入口
- 个人音色仅当前用户可见，默认不跨项目共享

### 14.3 性能要求

- PPT解析：100页PPTX解析（含图片导出）不超过60秒
- 配音生成：单页备注（200字）生成不超过10秒
- 视频合成：50页PPT+配音视频合成不超过120秒
- 前端交互：页面切换和播放控制响应不超过200ms

### 14.4 依赖升级规则

- Voicebox/OpenCut升级必须经过全链路回归：音色创建→模型下载→单页配音→自动翻页→编辑→导出
- 不允许只验证页面能打开就发布
- 必须保留不依赖编辑器的原始讲解视频和页面级音频资产

### 14.5 PRD待确认问题对开发的影响

以下PRD中标记"待确认"的问题会影响开发实现，AI开发代理在遇到这些参数时应使用第14.1节中的常量默认值：

| 待确认项 | 默认值 | 影响 |
|----------|--------|------|
| 文件大小上限 | 200MB | 文件校验 |
| 页数上限 | 200 | 解析校验 |
| 单页备注字数上限 | 10000字 | 解析校验 |
| 静音页默认时长 | 5秒 | 视频合成 |
| 静音页是否默认允许 | 允许 | 生成前校验 |
| 配音语速 | 约4字/秒(中文) | 预计时长估算 |
| 总超时阈值 | 30秒(解析)/60秒(配音) | 超时处理 |
| 视频输出规格 | MP4/H.264/1080p | 合成参数 |
| 是否支持拖拽导入 | 暂不支持 | 首页交互 |
