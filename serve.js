import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const port = Number(process.env.PORT ?? 8080);
createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const allowed = /^\/(?:index\.html|style\.css|main\.js|(?:data|engine|simulation|systems)\/[a-zA-Z]+\.js)$/;
  if (!allowed.test(path)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL('.' + path, import.meta.url));
    response.writeHead(200, { 'content-type': types[extname(path)] + '; charset=utf-8' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', function () {
  console.log(`Kingdom Observer running at http://127.0.0.1:${this.address().port}`);
});
