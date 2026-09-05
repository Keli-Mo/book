/*
 * 为多书首页设计原型同步已有云资源，不写入小程序代码或云端。
 * 封面来自真实书架常量；训练页按云文件页号关联原音频，保留既有坐标换算。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const prototypeRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(prototypeRoot, '../..');
const constantsRoot = path.join(projectRoot, 'src/pages/BookDetail/Components/BookPreview/constants');
const manifestPath = path.join(prototypeRoot, 'src/practiceManifest.json');

function readConstant(file, name) {
  const source = fs.readFileSync(file, 'utf8')
    .replace(/export\s*\{[^}]*\};?/g, '')
    .replace(/export\s+const\s/g, 'const ');
  return vm.runInNewContext(`${source}\n${name}`, {}, { timeout: 2000 });
}

const covers = readConstant(path.join(projectRoot, 'src/pages/Home/Components/BookShelf/constant.ts'), 'images');
const pages = readConstant(path.join(constantsRoot, 'images.ts'), 'concatImages')['3'];
const audioByPage = readConstant(path.join(constantsRoot, 'audioList.ts'), 'allAudioList')['3'];
const catalog = readConstant(path.join(constantsRoot, 'catalogList.ts'), 'catalogLists')['3'];

function filePageNumber(url) {
  const match = decodeURIComponent(url.split('?')[0]).match(/_(\d+)\.(?:png|jpe?g|webp)$/i);
  return match ? Number(match[1]) : null;
}

function position(track) {
  const [rawX = 0, rawY = 0] = track.offset || [];
  const left = track.flag === 'Cambridge' ? ((Number(rawX) - 3576) / 825) * 100
    : track.flag === 'Percentage' ? Number.parseFloat(String(rawX)) : ((Number(rawX) - 653) / 469) * 100;
  const top = track.flag === 'Cambridge' ? ((Number(rawY) - 202) / 1061) * 100
    : track.flag === 'Percentage' ? Number.parseFloat(String(rawY)) : ((Number(rawY) - 167) / 606) * 100;
  const safe = (value) => Number(Math.min(96, Math.max(1, Number.isFinite(value) ? value : 50)).toFixed(2));
  return { left: safe(left), top: safe(top) };
}

const jobs = [];
// 书架前两项是广告，排除后仍使用原始书籍 ID 3–25。
const bookAssets = covers.slice(2).map((url, index) => {
  const id = String(index + 3);
  // Our World 四个云文件虽以 .png 命名，实际文件头是 JPEG，本地使用正确后缀。
  const extension = ['11', '12', '13', '14'].includes(id) ? '.jpg' : path.extname(new URL(url).pathname);
  const assetPath = `/assets/books/book-${id}${extension}`;
  jobs.push({ url, assetPath, category: 'covers' });
  return { id, cover: assetPath };
});

const practices = pages.map((url, imageIndex) => ({ url, imageIndex, pageNumber: filePageNumber(url) }))
  .filter(({ pageNumber }) => [4, 5, 6].includes(pageNumber))
  .map(({ url, imageIndex, pageNumber }) => {
    const image = `/assets/practice/casa1-page-${pageNumber}.png`;
    jobs.push({ url, assetPath: image, category: 'pages' });
    const section = catalog.filter((item) => item.page <= imageIndex).sort((a, b) => b.page - a.page)[0]?.name || '课程导入';
    const tracks = (audioByPage[pageNumber] || []).map((track, index) => {
      const filename = decodeURIComponent(track.url.split('/').pop().split('?')[0]);
      const src = `/assets/practice/${filename}`;
      jobs.push({ url: track.url, assetPath: src, category: 'audio' });
      return { id: `3-${pageNumber}-${index}`, label: filename.replace(/\.mp3$/i, ''), src, ...position(track) };
    });
    if (!tracks.length) throw new Error(`源文件第 ${pageNumber} 页未找到对应音频`);
    return { id: `3-page-${pageNumber}`, bookId: '3', section, pageNumber, image, tracks };
  });

const manifestContent = `${JSON.stringify(practices, null, 2)}\n`;

function verifyManifest() {
  const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
  if (current !== manifestContent) {
    throw new Error('训练页清单与小程序源常量不一致，请运行 npm run sync:assets 后检查变更');
  }
  console.log('训练页、音频与热点坐标映射校验通过。');
}

async function download(job) {
  const destination = path.join(prototypeRoot, 'public', job.assetPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    return { assetPath: job.assetPath, category: job.category, bytes: fs.statSync(destination).size, cached: true };
  }
  const response = await fetch(job.url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`${job.assetPath}: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!/^(image\/|audio\/|application\/octet-stream)/.test(contentType)) {
    throw new Error(`${job.assetPath}: 非图片或音频响应 ${contentType}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error(`${job.assetPath}: 资源为空`);
  fs.writeFileSync(destination, buffer);
  console.log(`已同步 ${job.assetPath} (${buffer.length} 字节)`);
  return { assetPath: job.assetPath, category: job.category, bytes: buffer.length };
}

async function main() {
  // 清单由真实资源常量生成，页面代码只读取这一份稳定映射。
  fs.writeFileSync(manifestPath, manifestContent, 'utf8');
  const results = [];
  const failures = [];
  // 只并发读取远端资源，不调用上传、权限设置或其他写入 API。
  let cursor = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try { results.push(await download(job)); }
      catch (error) { failures.push({ assetPath: job.assetPath, error: error.message }); }
    }
  }));
  console.log(JSON.stringify({ bookAssets, practices, resourceCount: results.length, totalBytes: results.reduce((sum, item) => sum + item.bytes, 0), failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (process.argv.includes('--verify')) {
  try { verifyManifest(); }
  catch (error) { console.error(error); process.exitCode = 1; }
} else {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
