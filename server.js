import http from "node:http";
import { handleRequest } from "./src/http/router.js";

const port = Number(process.env.PORT || 3024);

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "internal_error", message: error.message }));
  });
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
