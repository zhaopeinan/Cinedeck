# 开放平台 API

通过 API Key 对外暴露 Voicebox TTS 与 Duix 数字人能力。

## 鉴权

1. 管理员登录后台 → **开放平台** → 创建密钥（勾选 `tts` / `avatar`）
2. 明文 `sk_...` 仅创建时显示一次，请妥善保存
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

---

## 管理端 API（需管理员 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/open-platform/keys` | 列表 |
| POST | `/api/v1/open-platform/keys` | 创建（返回一次 `apiKey`） |
| PATCH | `/api/v1/open-platform/keys/:id` | 改名 / scopes / 启用禁用 |
| DELETE | `/api/v1/open-platform/keys/:id` | 删除 |
