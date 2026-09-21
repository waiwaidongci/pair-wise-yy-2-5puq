import http from "node:http";
import { JsonStore } from "./src/store.js";
import { createApi, HttpError } from "./src/routes.js";
import { page } from "./src/page.js";

const port = Number(process.env.PORT || 3024);
const store = new JsonStore();
const api = createApi(store);

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    const result = await api.handle(req, url);
    return sendJson(res, result.status, result.body);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.error, message: error.message });
    return sendJson(res, 500, { error: "server_error", message: error.message });
  }
});

server.listen(port, () => console.log(`赛鸽转让生效与权益台 listening on http://localhost:${port}`));
