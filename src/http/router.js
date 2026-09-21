// 请求入口模块：HTTP 路由、请求解析、领域错误到状态码的映射。
// 业务判定全部委托 src/domain/equity.js，读写全部经过 src/store/repository.js。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, transact } from "../store/repository.js";
import {
  DomainError, summarize, createPigeon, pedigree, ledger,
  createTransfer, confirmTransfer, correctTransfer, cancelTransfer,
  createEntry, recordResult, addVaccine
} from "../domain/equity.js";

const pagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "index.html");

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(pagePath, "utf8"));
    }
    if (req.method === "GET" && path === "/api/pigeons") {
      return sendJson(res, 200, summarize(await loadDb()));
    }
    if (req.method === "POST" && path === "/api/pigeons") {
      const input = await readBody(req);
      const pigeon = await transact(db => createPigeon(db, input));
      return sendJson(res, 201, pigeon);
    }

    let match = path.match(/^\/api\/pigeons\/([^/]+)\/relation$/);
    if (match && req.method === "GET") {
      return sendJson(res, 200, pedigree(await loadDb(), decodeURIComponent(match[1])));
    }
    match = path.match(/^\/api\/pigeons\/([^/]+)\/ledger$/);
    if (match && req.method === "GET") {
      return sendJson(res, 200, ledger(await loadDb(), decodeURIComponent(match[1])));
    }
    match = path.match(/^\/api\/pigeons\/([^/]+)\/transfers$/);
    if (match && req.method === "POST") {
      const input = await readBody(req);
      const transfer = await transact(db => createTransfer(db, decodeURIComponent(match[1]), input));
      return sendJson(res, 201, transfer);
    }
    match = path.match(/^\/api\/pigeons\/([^/]+)\/entries$/);
    if (match && req.method === "POST") {
      const input = await readBody(req);
      const entry = await transact(db => createEntry(db, decodeURIComponent(match[1]), input));
      return sendJson(res, 201, entry);
    }
    match = path.match(/^\/api\/pigeons\/([^/]+)\/vaccines$/);
    if (match && req.method === "POST") {
      const input = await readBody(req);
      const record = await transact(db => addVaccine(db, decodeURIComponent(match[1]), input));
      return sendJson(res, 201, record);
    }
    match = path.match(/^\/api\/transfers\/([^/]+)\/confirm$/);
    if (match && req.method === "POST") {
      const input = await readBody(req);
      const transfer = await transact(db => confirmTransfer(db, match[1], input.role));
      return sendJson(res, 200, transfer);
    }
    match = path.match(/^\/api\/transfers\/([^/]+)\/cancel$/);
    if (match && req.method === "POST") {
      const transfer = await transact(db => cancelTransfer(db, match[1]));
      return sendJson(res, 200, transfer);
    }
    match = path.match(/^\/api\/transfers\/([^/]+)$/);
    if (match && req.method === "PATCH") {
      const input = await readBody(req);
      const transfer = await transact(db => correctTransfer(db, match[1], input));
      return sendJson(res, 200, transfer);
    }
    match = path.match(/^\/api\/entries\/([^/]+)\/result$/);
    if (match && req.method === "POST") {
      const input = await readBody(req);
      const entry = await transact(db => recordResult(db, match[1], input));
      return sendJson(res, 200, entry);
    }
    sendJson(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: error.code || "internal_error", message: error.message });
  }
}
