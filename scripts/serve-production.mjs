/**
 * Назначение файла: Локальный HTTP-preview для Pages-сборки и browser-тестов.
 * Воспроизводит подпуть репозитория и MIME Wasm; слушает только 127.0.0.1.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = resolve("dist/terminal/browser");
const prefix = "/findev-test/";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(302, { Location: prefix });
    res.end();
    return;
  }
  // Некорректный percent-escape должен дать 400, а не необработанное исключение и падение Node.
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname.slice(prefix.length - 1));
  } catch {
    res.writeHead(400);
    res.end("Malformed request path");
    return;
  }
  const file = resolve(
    root,
    "." + pathname,
    url.pathname.endsWith("/") ? "index.html" : "",
  );
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("Not a file");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
// PORT=0 позволяет профилировщику получить свободный порт без гонки между поиском и bind.
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid PORT");
server.listen(port, "127.0.0.1", () =>
  console.log(`Local: http://127.0.0.1:${server.address().port}/findev-test/`),
);
