/**
 * generate-icon.js — 生成扩展图标
 * 一个简洁的上升 K 线图标，红色（A股涨=红）
 */
const fs = require("fs");
const path = require("path");

// 极简 PNG 生成器（纯代码，不依赖第三方库）
// 生成一个纯色背景 + 简单图案的 PNG

function createCanvas(size) {
  // 使用 canvas API 不可用，改用 SVG → PNG 的方式也不行
  // 这里直接用一个预制的 base64 图标
  return null;
}

// 直接使用一个嵌入式的 SVG → 用 sharp/canvas 转换不现实
// 换方案：手写一个最小的有效 PNG

// 更实用的方案：生成一个 SVG 图标文件，manifest 引用 SVG
// 但 Chrome 扩展的 icons 必须是 PNG
// 所以这里用纯 JS 生成一个简单的 PNG

function makePNG(size) {
  const { createCanvas } = (() => {
    try {
      return require("canvas");
    } catch {
      return { createCanvas: null };
    }
  })();

  if (createCanvas) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");

    // 背景：圆角矩形
    const r = size * 0.2;
    ctx.fillStyle = "#e33232";
    roundRect(ctx, 0, 0, size, size, r);
    ctx.fill();

    // K线图
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = size * 0.06;

    const cx = size / 2;
    const cy = size / 2;

    // 简单的上升折线
    ctx.beginPath();
    ctx.moveTo(size * 0.2, size * 0.75);
    ctx.lineTo(size * 0.4, size * 0.55);
    ctx.lineTo(size * 0.6, size * 0.65);
    ctx.lineTo(size * 0.8, size * 0.25);
    ctx.stroke();

    // 箭头头
    ctx.beginPath();
    ctx.moveTo(size * 0.8, size * 0.25);
    ctx.lineTo(size * 0.68, size * 0.25);
    ctx.lineTo(size * 0.8, size * 0.38);
    ctx.closePath();
    ctx.fill();

    return canvas.toBuffer("image/png");
  }

  return null;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 尝试安装 canvas 并生成
const { execSync } = require("child_process");
const sizes = [16, 48, 128];
const outDir = path.join(__dirname, "icons");

for (const s of sizes) {
  const buf = makePNG(s);
  if (buf) {
    fs.writeFileSync(path.join(outDir, `icon${s}.png`), buf);
    console.log(`Generated icon${s}.png`);
  } else {
    console.log(`canvas unavailable for size ${s}, will use fallback`);
  }
}
