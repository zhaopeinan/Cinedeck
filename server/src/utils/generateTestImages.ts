/**
 * 生成测试用的 PNG 图片（无需第三方库，使用 Node 内置 zlib）
 * 在服务启动时调用，确保测试图片存在
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const WIDTH = 200;
const HEIGHT = 200;

/** 生成 RGBA 像素数据 */
function createPixelData(draw: (x: number, y: number) => [number, number, number, number]): Buffer {
  const data = Buffer.alloc(HEIGHT * (1 + WIDTH * 4)); // 每行开头有 1 字节 filter
  for (let y = 0; y < HEIGHT; y++) {
    data[y * (1 + WIDTH * 4)] = 0; // filter: None
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b, a] = draw(x, y);
      const offset = y * (1 + WIDTH * 4) + 1 + x * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return data;
}

/** 将 RGBA 像素数据编码为 PNG 文件 */
function encodePng(pixelData: Buffer): Buffer {
  // PNG 签名
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // IDAT chunk (压缩像素数据)
  const compressed = zlib.deflateSync(pixelData);

  // IEND chunk
  const iend = Buffer.alloc(0);

  // 组装 chunks（每个 chunk: length + type + data + CRC）
  function makeChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, 'ascii');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(data.length, 0);
    const crcData = Buffer.concat([typeBuf, data]);
    const crc = crc32(crcData);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);
    return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
  }

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', iend),
  ]);
}

/** CRC32 计算 */
function crc32(buf: Buffer): number {
  if (!(crc32 as any).table) {
    const t = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c;
    }
    (crc32 as any).table = t;
  }
  const table = (crc32 as any).table as number[];
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 生成城市夜景：深色背景 + 霓虹灯点 */
function genCity(): Buffer {
  return encodePng(createPixelData((x, y) => {
    // 深紫蓝渐变背景
    const t = y / HEIGHT;
    const r = Math.round(15 + t * 10);
    const g = Math.round(10 + t * 5);
    const b = Math.round(40 + (1 - t) * 30);
    // 随机霓虹灯点
    const seed = (x * 7 + y * 13) % 100;
    if (seed < 3) return [255, 50, 150, 255]; // 粉
    if (seed >= 3 && seed < 5) return [50, 200, 255, 255]; // 青
    if (seed >= 5 && seed < 6) return [255, 200, 50, 255]; // 黄
    // 建筑轮廓（底部矩形）
    if (y > HEIGHT * 0.5) {
      const bx = x % 40;
      if (bx < 2 || bx > 37) return [20, 15, 35, 255]; // 建筑边
      if (y > HEIGHT * 0.6 && (x * 3 + y * 2) % 17 < 2) return [255, 220, 100, 255]; // 窗户
    }
    return [r, g, b, 255];
  }));
}

/** 生成自然风光：天空 + 山 + 湖 */
function genNature(): Buffer {
  return encodePng(createPixelData((x, y) => {
    const horizon = HEIGHT * 0.45;
    if (y < horizon) {
      // 天空渐变
      const t = y / horizon;
      return [Math.round(135 + t * 40), Math.round(180 + t * 30), Math.round(220 + t * 20), 255];
    }
    // 山脉
    const mountainHeight = Math.sin(x * 0.03) * 30 + Math.sin(x * 0.08) * 15 + 50;
    if (y < horizon + mountainHeight) {
      const t = (y - horizon) / mountainHeight;
      return [Math.round(80 - t * 30), Math.round(100 - t * 30), Math.round(90 - t * 20), 255];
    }
    // 湖面（带反光）
    const t = (y - horizon - mountainHeight) / (HEIGHT - horizon - mountainHeight);
    const shimmer = Math.sin(x * 0.1 + t * 5) * 10;
    return [Math.round(60 + shimmer), Math.round(120 + shimmer), Math.round(160 + shimmer), 255];
  }));
}

/** 生成数据图表：柱状图 + 饼图 */
function genChart(): Buffer {
  const bars = [0.3, 0.5, 0.75, 0.6, 0.85];
  const barColors: [number, number, number][] = [[66, 133, 244], [234, 67, 53], [251, 188, 4], [52, 168, 83], [171, 71, 188]];
  return encodePng(createPixelData((x, y) => {
    // 白色背景
    let bg: [number, number, number] = [255, 255, 255];
    // 轴线
    if (x < 3 || (y > HEIGHT - 3 && x < WIDTH * 0.6)) bg = [100, 100, 100];
    // 柱状图
    if (x < WIDTH * 0.55) {
      const barIndex = Math.floor(x / (WIDTH * 0.55 / bars.length));
      const barX = x % (WIDTH * 0.55 / bars.length);
      if (barX > 2 && barX < (WIDTH * 0.55 / bars.length) - 2 && barIndex < bars.length) {
        const barTop = HEIGHT - HEIGHT * 0.7 * bars[barIndex];
        if (y > barTop && y < HEIGHT - 3) {
          bg = barColors[barIndex];
        }
      }
    }
    // 饼图（右下角）
    const pieCx = WIDTH * 0.78;
    const pieCy = HEIGHT * 0.5;
    const pieR = 35;
    const dx = x - pieCx;
    const dy = y - pieCy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < pieR) {
      const angle = Math.atan2(dy, dx);
      const seg = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 5);
      bg = barColors[seg % 5];
    }
    return [bg[0], bg[1], bg[2], 255];
  }));
}

/** 生成办公场景：桌子 + 电脑 + 文件 */
function genOffice(): Buffer {
  return encodePng(createPixelData((x, y) => {
    // 墙壁（上半部分）
    if (y < HEIGHT * 0.55) {
      return [230, 225, 215, 255];
    }
    // 桌面（下半部分）
    if (y < HEIGHT * 0.58) return [180, 160, 140, 255]; // 桌沿
    // 电脑屏幕
    if (x > WIDTH * 0.2 && x < WIDTH * 0.6 && y > HEIGHT * 0.2 && y < HEIGHT * 0.5) {
      if (x < WIDTH * 0.22 || x > WIDTH * 0.58 || y < HEIGHT * 0.22 || y > HEIGHT * 0.48) return [60, 60, 60, 255]; // 边框
      return [60, 120, 180, 255]; // 屏幕蓝
    }
    // 电脑支架
    if (x > WIDTH * 0.35 && x < WIDTH * 0.45 && y > HEIGHT * 0.48 && y < HEIGHT * 0.55) return [80, 80, 80, 255];
    // 文件堆（右侧）
    if (x > WIDTH * 0.7 && x < WIDTH * 0.9 && y > HEIGHT * 0.6 && y < HEIGHT * 0.8) {
      const layer = Math.floor((y - HEIGHT * 0.6) / 8);
      return layer % 2 === 0 ? [240, 240, 235, 255] : [200, 200, 195, 255];
    }
    // 桌面木纹
    return [160, 130, 100, 255];
  }));
}

/** 确保测试图片存在，不存在则生成 */
export function ensureTestImages(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const images = [
    { filename: 'test-city.png', gen: genCity },
    { filename: 'test-nature.png', gen: genNature },
    { filename: 'test-chart.png', gen: genChart },
    { filename: 'test-office.png', gen: genOffice },
  ];
  for (const img of images) {
    const filepath = path.join(dir, img.filename);
    if (!fs.existsSync(filepath)) {
      fs.writeFileSync(filepath, img.gen());
      console.log(`[TestImages] 生成测试图片: ${img.filename}`);
    }
  }
}
