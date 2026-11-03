# 数字人解说 · 绿幕叠底视频

独立页路径：`/avatar`

## 流程

1. **素材**：准备绿幕数字人（Duix 生成 / 上传 / 素材库）+ 底视频  
2. **摆位**：拖拽位置与大小，调节抠绿强度（浏览器实时近似预览）  
3. **预览**：服务端 ffmpeg 短预览（约前 8 秒，参数与导出一致）  
4. **导出**：全片合成并下载  

## API

均需登录 JWT。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/avatar/compose` | multipart：`mode=preview\|export`，`background`，绿幕三选一（`greenscreen` 文件 / `greenscreenJobId` / `greenscreenRefId`），`layout` JSON，`chromaSimilarity` |
| GET | `/api/v1/avatar/compose/:id` | 进度 |
| GET | `/api/v1/avatar/compose/:id/video` | 预览或成片 |

`chromaSimilarity` 默认 `0.28`，范围约 `0.05–0.6`（越大抠绿越狠）。
