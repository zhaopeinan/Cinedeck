# Cinedeck

把带演讲者备注的 PPTX 做成按页播放的讲解视频。

上传课件后，系统读取每页备注作为口播文案，用选定音色生成配音，再按页面顺序合成讲解视频。也可以继续做数字人出镜、转写和二次编辑。

## 本地开发

前端：

```bash
cd client
npm install
npm run dev
```

后端：

```bash
cd server
npm install
npm run dev
```

也可以用仓库根目录的 `docker-compose.yml` 启动。语音合成、数字人和渲染依赖本机或容器里的配套服务，通过环境变量配置地址，不把密钥写进仓库。

首次启动会在本地数据库创建默认管理员 `admin` / `admin123`。公开部署前请立刻修改密码，并设置 `JWT_SECRET`。
