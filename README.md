<img src="docs/cinedeck-banner.png" alt="Cinedeck — 让每一页幻灯片化作一段影像" width="100%">

# Cinedeck

Cinedeck turns a PPTX deck into a lecture video. Speaker notes are the script. Each slide stays on screen for the length of its narration, in the original page order.

Cinedeck 把一份 PPTX 课件做成讲解视频。演讲者备注就是口播稿，每一页按配音时长停留，页面顺序与原稿一致。

The interface is in Chinese. This document is written in both languages so you can install it either way.

界面是中文的。下面的安装说明中英对照，按任意一种语言往下做即可。

## What you get

| | |
|---|---|
| Step-by-step lecture | Import a PPTX, read notes, pick one voice, render a video. 分步向导：导入课件、核对备注、选定一种音色、导出成片。 |
| One-shot batch | Parse, write narration, dub, and compose in one job, including batches. 一键全自动：解析、解说、配音、合成串行跑完，支持批量。 |
| Voice workshop | Clone a voice or use a preset, then preview single-speaker and dialogue audio. 造声工厂：克隆或选用预置音色，试听单人与多人对话。 |
| Presenter | Drive lip-sync from a photo or reference video plus an audio track. 数字人：用照片或参考视频配合音频生成口型。 |
| Lecture animation | Build a HyperFrames composition from the deck. HyperFrame 讲授动画：从课件生成动画工程。 |
| Transcript | Transcribe an audio or video file. 视频转写：把音视频识别成文本。 |

Accounts, a slider captcha, and an admin console are built in. Projects, audio, video, and the SQLite database stay on the machine that runs the API. None of that is part of this repository.

自带账号、滑块验证码和管理后台。项目、音频、视频和 SQLite 数据库都落在运行 API 的那台机器上，不会进入本仓库。

## Requirements

| Tool | Used for |
|---|---|
| Node.js 20+ and npm | API (`server/`) and web app (`client/`). API 与网页。 |
| Python 3, `python-pptx` | Reading speaker notes. 读取演讲者备注。 |
| LibreOffice Impress | Rendering each slide. 把每一页渲成图片。 |
| Poppler (`pdftoppm`), or `pdf2image` + Pillow | Turning the exported PDF into PNGs. 把导出的 PDF 拆成 PNG。 |
| FFmpeg and FFprobe | Composing and exporting video. 合成与导出视频。 |
| Git | First-run checkout of [Voicebox](https://github.com/jamiepine/voicebox), unless you point at one that is already running. 首次启动时拉取 Voicebox；若你已经有实例，可以跳过。 |

macOS:

```bash
brew install --cask libreoffice
brew install poppler ffmpeg
python3 -m pip install python-pptx pdf2image Pillow
```

Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y libreoffice-impress poppler-utils ffmpeg python3 python3-pip
python3 -m pip install --break-system-packages python-pptx pdf2image Pillow
```

`pdf2image` still needs Poppler. If the Python package is missing, the API falls back to `pdftoppm`.

`pdf2image` 仍然依赖 Poppler。没装这个 Python 包时，API 会改用 `pdftoppm`。

Avatar lip-sync, HyperFrames rendering, and GPU encoding are separate services. The app starts without them. Those screens report the service as unavailable until you attach it.

数字人口型、HyperFrames 渲染和 GPU 编码是另外的服务。不接它们，应用本身也能启动；对应页面会显示服务不可用。

## Run it locally

Use two terminals. Start the API from `server/`. The process stores its database and uploads in `../data` relative to that directory, which is `<repo>/data`.

开两个终端。API 必须在 `server/` 目录里启动。数据库和上传文件写到该目录的 `../data`，也就是仓库下的 `data/`。

**1. API — port 3001**

```bash
cd server
npm install
npm run dev
```

The first boot creates `data/ppt_audio.db` and a local admin account. It then tries to reach Voicebox at `http://localhost:17493`. If nothing is listening, it clones Voicebox into `<repo>/voicebox` and starts it. That checkout is gitignored. A failed Voicebox start does not stop the API; dubbing stays unavailable until the service is up.

第一次启动会创建 `data/ppt_audio.db` 和本地管理员账号，然后探测 `http://localhost:17493` 上的 Voicebox。没有服务在听时，它会把 Voicebox 克隆到仓库里的 `voicebox/` 并拉起。这个目录已被 gitignore。Voicebox 启动失败不会拖垮 API，只是配音暂时不可用。

Check the API:

```bash
curl -s http://localhost:3001/api/health
```

A healthy process returns `"status":"ok"`. `"voicebox":"starting"` means the TTS process is still coming up.

正常时应返回 `"status":"ok"`。`"voicebox":"starting"` 表示语音服务还在启动。

**2. Web — port 5173**

```bash
cd client
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` and `/data` to port 3001, so the browser talks to one origin in development.

浏览器打开 [http://localhost:5173](http://localhost:5173)。开发模式下 Vite 把 `/api` 和 `/data` 代理到 3001，浏览器只访问一个源。

**3. Sign in**

| | |
|---|---|
| Username 用户名 | `admin` |
| Password 密码 | `admin123` |

The account is created only when the user table is empty. Change the password before this process is reachable by anyone else, and set `JWT_SECRET` to a long random value. The built-in fallback is for a private workstation, not for a shared host.

用户表为空时才会创建这个账号。只要这台服务会被别人访问到，就先改密码，并把 `JWT_SECRET` 设成一段足够长的随机字符串。代码里的默认值只适合私人工作站，不适合共享主机。

**4. Make a video**

1. Sign in and open **分步向导**.
2. Upload a `.pptx` whose speaker notes are the script. Decks from WPS sometimes need to be re-saved as standard PPTX by PowerPoint before LibreOffice will render them.
3. Confirm the notes, choose one voice for the whole project, generate audio, then compose the video.

1. 登录后进入「分步向导」。
2. 上传一份备注写好口播稿的 `.pptx`。WPS 导出的文件有时要先用 PowerPoint 另存为标准 PPTX，LibreOffice 才能渲染。
3. 核对备注，为整个项目选定一种音色，生成配音，再合成视频。

Production build of the two packages, without Docker:

```bash
cd server && npm install && npm run build && npm start
cd client && npm install && npm run build && npm run preview
```

`npm start` serves the compiled API from `server/dist`. Run it with the working directory still set to `server/`, or the data directory resolves to the wrong place.

`npm start` 跑的是 `server/dist` 里的编译结果。工作目录仍须是 `server/`，否则数据目录会指到别处。

## Voicebox

Dubbing uses [Voicebox](https://github.com/jamiepine/voicebox) over HTTP. Two ways to provide it:

配音通过 HTTP 调用 [Voicebox](https://github.com/jamiepine/voicebox)。两种接法：

- Let the API clone and start it. You need `git`, `python3`, and `pip` on `PATH`. The first model download is large.
- 让 API 自己克隆并启动。`PATH` 里要有 `git`、`python3` 和 `pip`。首次下载模型体积不小。
- Start Voicebox yourself and point the API at it:

```bash
export VOICEBOX_BASE_URL=http://127.0.0.1:17493
```

Manual start, from a Voicebox checkout:

```bash
python3 -m backend.main --host 127.0.0.1 --port 17493
```

`VOICEBOX_DIR` overrides the clone location. The default is `<repo>/voicebox` when the API is launched from `server/`.

`VOICEBOX_DIR` 可以改克隆位置。从 `server/` 启动时，默认是仓库下的 `voicebox/`。

## Optional services

These are not required to boot, sign in, or parse a deck.

下面这些不参与启动、登录和课件解析。

| Capability | What it expects |
|---|---|
| Presenter / 数字人 | A running Duix or OpenTalking container. See `DUIX_*` and `OPENTALKING_CONTAINER` below. |
| HyperFrames | The `ppt-audio-hyperframes` image from `docker/hyperframes`. |
| Timeline export / 时间轴导出 | OpenCut on `OPENCUT_BASE_URL`, default `http://localhost:5174`. |
| GPU encode / GPU 编码 | NVIDIA drivers visible to FFmpeg. Otherwise encoding falls back to software. 否则走软件编码。 |

## Docker

`docker-compose.yml` is the layout for a host that already runs the avatar stack. It is not a standalone demo.

`docker-compose.yml` 是给已经跑着数字人环境的主机用的，不是开箱即用的演示。

`dispatcher` joins an external network named `deploy_ai_network`, and bind-mounts `/opt/opentalking` and `/data/duix_avatar_data/face2face`. Compose will exit until that network exists. The GPU reservation also assumes an NVIDIA runtime.

`dispatcher` 要加入名为 `deploy_ai_network` 的外部网络，并挂载 `/opt/opentalking` 和 `/data/duix_avatar_data/face2face`。这个网络不存在时 Compose 会直接退出。GPU 预留还要求 NVIDIA 运行时。

On such a host:

```bash
docker network create deploy_ai_network   # skip when the Duix stack already created it
docker compose up -d --build dispatcher frontend
```

The site is published on port **5173**, the API on **3001**. Nginx in the frontend container proxies `/api` and `/data` to `dispatcher`.

网页在 **5173**，API 在 **3001**。前端容器里的 Nginx 把 `/api` 和 `/data` 转到 `dispatcher`。

Extra profiles, same host:

```bash
docker compose --profile full up -d --build          # worker
docker compose --profile hyperframes up -d --build   # Chromium renderer
```

## Configuration

Set these in the environment of the API process. Nothing in the repository is a secret.

这些变量配在 API 进程的环境里。仓库中不存放密钥。

| Variable | Default | |
|---|---|---|
| `PORT` | `3001` | API listen port. API 端口。 |
| `JWT_SECRET` | a development fallback | Required before any shared deployment. 对外提供服务前必须改掉。 |
| `VOICEBOX_BASE_URL` | `http://localhost:17493` | Voicebox base URL. |
| `VOICEBOX_DIR` | `<repo>/voicebox` | Where the API clones Voicebox. API 克隆 Voicebox 的位置。 |
| `OPENCUT_BASE_URL` | `http://localhost:5174` | OpenCut. |
| `DUIX_API_BASE` | `http://duix-avatar-gen-video:8383` | Duix HTTP API. |
| `DUIX_CONTAINER` | `duix-avatar-gen-video` | Duix container name. |
| `OPENTALKING_CONTAINER` | `opentalking-smoke` | OpenTalking container name. |
| `HYPERFRAMES_IMAGE` | `ppt-audio-hyperframes:latest` | Renderer image. 渲染镜像。 |

## Layout

```
client/     React, Vite, Ant Design
server/     Express API, SQLite, PPT and video jobs
shared/     Types used by both sides
docker/     Worker, Voicebox, and HyperFrames images
```

Uploaded decks and rendered media go to `data/`, which is ignored by git. Logs from a real course do not belong in the tree.

上传的课件和成片在 `data/`，已被 git 忽略。真实课程的产物不应该进仓库。

## Security

- Replace `admin` / `admin123` on first login. Five failures lock the account for 15 minutes. 首次登录就改掉默认口令。连续失败 5 次会锁定 15 分钟。
- Set `JWT_SECRET`. Tokens last 7 days. 设置 `JWT_SECRET`。令牌有效期 7 天。
- Do not publish port 3001 on a public interface without TLS and a changed admin password. 不要在未启用 TLS、且仍使用默认管理员密码时，把 3001 暴露到公网。
- Avatar reference video is served only through the authenticated API. Static `/data/private` is not exposed. 数字人参考视频只走登录后的 API，静态路径 `/data/private` 不对外。

## License

[ISC](https://opensource.org/license/isc-license-txt), as declared in `server/package.json`.

许可协议为 [ISC](https://opensource.org/license/isc-license-txt)，见 `server/package.json`。
