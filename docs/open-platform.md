# 开放平台 API

通过 API Key 对外暴露 Voicebox TTS、Duix 数字人生成，以及**绿幕叠底视频合成**能力。

## 鉴权

1. 管理员登录后台 → **开放平台** → 创建密钥（勾选 `tts` / `avatar`）
2. 完整 `sk_...` 会一直显示在密钥列表中，可随时复制
3. 调用时任选一种方式：

```http
Authorization: Bearer sk_xxxxxxxx
```

或：

```http
X-API-Key: sk_xxxxxxxx
```

限流：默认每个 Key **60 次/分钟**（可用环境变量 `OPEN_API_RPM` 调整）。

Base URL 示例：`https://172.31.246.72/api/open/v1`

---

## TTS（需 scope: `tts`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/tts/voices` | 音色列表 |
| POST | `/tts/voices` | 克隆音色（multipart：`audio` + `name` + `language`） |
| DELETE | `/tts/voices/:id` | 删除音色 |
| GET | `/tts/voices/:id/sample` | 试听 |
| POST | `/tts/generate` | 文本生成配音 |
| GET | `/tts/tasks/:id` | 任务状态 |
| GET | `/tts/tasks/:id/result` | 结果元数据 |
| GET | `/tts/tasks/:id/audio` | 下载/播放音频 |
| POST | `/tts/tasks/:id/cancel` | 取消任务 |

### 生成配音

```bash
curl -sS -X POST "$BASE/tts/generate" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "你好，这是开放平台测试。",
    "voice_id": "<voice-id>",
    "model_id": "<model-id>",
    "language": "zh-CN"
  }'
```

轮询状态后下载：

```bash
curl -sS -H "Authorization: Bearer $API_KEY" "$BASE/tts/tasks/<task-id>"
curl -sS -H "Authorization: Bearer $API_KEY" \
  "$BASE/tts/tasks/<task-id>/audio?download=1" -o out.wav
```

---

## Avatar / Duix（需 scope: `avatar`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/avatar/jobs` | 提交任务（multipart） |
| GET | `/avatar/jobs/:id` | 查询进度 |
| GET | `/avatar/jobs/:id/video` | 下载成片 |
| POST | `/avatar/jobs/:id/cancel` | 取消 |

字段：

- `driveMode`：`photo`（静照口型）或 `video`（参考视频驱动）
- `audio`：WAV/MP3（建议 ≤120 秒）
- `photo`：JPG/PNG（`driveMode=photo` 时必填）
- `template` 或 `video`：参考视频（`driveMode=video` 时必填）

### 静照口型

```bash
curl -sS -X POST "$BASE/avatar/jobs" \
  -H "Authorization: Bearer $API_KEY" \
  -F "driveMode=photo" \
  -F "photo=@face.jpg" \
  -F "audio=@narration.wav"
```

### 参考视频驱动

```bash
curl -sS -X POST "$BASE/avatar/jobs" \
  -H "Authorization: Bearer $API_KEY" \
  -F "driveMode=video" \
  -F "template=@ref.mp4" \
  -F "audio=@narration.wav"
```

查询与下载：

```bash
curl -sS -H "Authorization: Bearer $API_KEY" "$BASE/avatar/jobs/<job-id>"
curl -sS -H "Authorization: Bearer $API_KEY" \
  "$BASE/avatar/jobs/<job-id>/video" -o avatar.mp4
```

### 绿幕叠底视频（compose）

把绿幕数字人片叠到任意底视频上（纯 ffmpeg，不占 Duix GPU）。需同一 Key 的 `avatar` scope。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/avatar/compose` | 提交预览或导出 |
| GET | `/avatar/compose/:id` | 查询进度 |
| GET | `/avatar/compose/:id/video` | 下载预览/成片 |

字段（multipart）：

- `mode`：`preview`（约前 8 秒）或 `export`（全片）
- `background`：底视频（必填，≤200MB）
- `greenscreen`：绿幕视频文件；**或** `greenscreenJobId`（本 Key 下已完成的 `/avatar/jobs` 成片）
- `layout`：JSON，如 `{"x":0.72,"y":0.52,"w":0.25,"h":0.444}`（相对底画面 0–1）
- `chromaSimilarity`：抠绿强度，默认 `0.28`，约 `0.05–0.6`（越大抠得越狠）
- `chromaBlend`：可选，默认 `0.1`

导出示例（上传绿幕 + 底视频）：

```bash
curl -sS -X POST "$BASE/avatar/compose" \
  -H "Authorization: Bearer $API_KEY" \
  -F "mode=export" \
  -F "background=@bg.mp4" \
  -F "greenscreen=@avatar_greenscreen.mp4" \
  -F 'layout={"x":0.72,"y":0.52,"w":0.25,"h":0.444}' \
  -F "chromaSimilarity=0.28"
```

先 Duix 生成再合成：

```bash
# 1) 生成绿幕数字人 → 得到 job-id
# 2) 叠底：
curl -sS -X POST "$BASE/avatar/compose" \
  -H "Authorization: Bearer $API_KEY" \
  -F "mode=preview" \
  -F "background=@bg.mp4" \
  -F "greenscreenJobId=<job-id>" \
  -F 'layout={"x":0.7,"y":0.5,"w":0.28,"h":0.5}' \
  -F "chromaSimilarity=0.30"
```

轮询与下载：

```bash
curl -sS -H "Authorization: Bearer $API_KEY" "$BASE/avatar/compose/<compose-id>"
curl -sS -H "Authorization: Bearer $API_KEY" \
  "$BASE/avatar/compose/<compose-id>/video" -o composed.mp4
```

---

## 管理端 API（需管理员 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/open-platform/keys` | 列表 |
| POST | `/api/v1/open-platform/keys` | 创建（响应含完整 `apiKey`，列表也可回看） |
| PATCH | `/api/v1/open-platform/keys/:id` | 改名 / scopes / 启用禁用 |
| DELETE | `/api/v1/open-platform/keys/:id` | 删除 |
