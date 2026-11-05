import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** dev server：esbuild 打包 src/main.tsx → dist/ + node:http 静态服务（端口固定，无时钟依赖以外状态） */

const PORT = 4173;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(packageRoot, 'dist');

mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [join(packageRoot, 'src', 'main.tsx')],
  outfile: join(distDir, 'main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'info',
});

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveFile(filePath: string, respond: (status: number, body: string, type: string) => void): void {
  try {
    const body = readFileSync(filePath);
    const type = contentTypes[filePath.slice(filePath.lastIndexOf('.'))] ?? 'application/octet-stream';
    respond(200, body.toString('utf-8'), type);
  } catch {
    respond(404, 'not found', 'text/plain; charset=utf-8');
  }
}

const server = createServer((request, respondRaw) => {
  const respond = (status: number, body: string, type: string): void => {
    respondRaw.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    respondRaw.end(body);
  };
  const url = request.url ?? '/';
  if (url === '/' || url === '/index.html') {
    serveFile(join(packageRoot, 'index.html'), respond);
    return;
  }
  const relative = url.replace(/^\/+/, '');
  if (relative.includes('..')) {
    respond(400, 'bad request', 'text/plain; charset=utf-8');
    return;
  }
  serveFile(join(packageRoot, relative), respond);
});

server.listen(PORT, () => {
  process.stdout.write(`demo app listening on http://localhost:${PORT}/\n`);
});
