// Test A: logging reverse proxy standing in for the Gateway's model proxy.
// Records, per request: path, streaming flag, tool count, cache_control presence,
// anthropic-beta header, response content-type, and whether SSE chunks flowed.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const PORT = Number(process.env.PROXY_PORT || 8787);
const LOG = process.env.PROXY_LOG || "proxy-log.jsonl";
const UPSTREAM = "api.anthropic.com";

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    let meta = { ts: new Date().toISOString(), method: req.method, path: req.url };
    try {
      const j = JSON.parse(body.toString());
      meta.model = j.model;
      meta.stream = j.stream === true;
      meta.tools = Array.isArray(j.tools) ? j.tools.length : 0;
      const s = body.toString();
      meta.cache_control_count = (s.match(/"cache_control"/g) || []).length;
      meta.has_system = !!j.system;
    } catch { meta.non_json = true; }
    meta.req_headers = {
      "anthropic-beta": req.headers["anthropic-beta"],
      "anthropic-version": req.headers["anthropic-version"],
      auth: req.headers["authorization"] ? "Bearer..." : req.headers["x-api-key"] ? "x-api-key" : "none",
      "user-agent": req.headers["user-agent"],
    };
    const headers = { ...req.headers, host: UPSTREAM };
    delete headers["content-length"];
    headers["content-length"] = String(body.length);
    const t0 = Date.now();
    const up = https.request({ hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers }, (ur) => {
      meta.status = ur.statusCode;
      meta.res_content_type = ur.headers["content-type"];
      let sseChunks = 0, firstByte = null, bytes = 0;
      res.writeHead(ur.statusCode, ur.headers);
      let errBody = ""; ur.on("data", (c) => { if (firstByte === null) firstByte = Date.now() - t0; sseChunks++; bytes += c.length; if (ur.statusCode !== 200) errBody += c.toString().slice(0, 300); res.write(c); });
      ur.on("end", () => {
        meta.sse_chunks = sseChunks; meta.ttfb_ms = firstByte; meta.bytes = bytes; meta.total_ms = Date.now() - t0; if (errBody) meta.error_body = errBody;
        fs.appendFileSync(LOG, JSON.stringify(meta) + String.fromCharCode(10));
        res.end();
      });
    });
    up.on("error", (e) => { meta.error = String(e); fs.appendFileSync(LOG, JSON.stringify(meta) + String.fromCharCode(10)); res.writeHead(502); res.end(); });
    up.write(body); up.end();
  });
}).listen(PORT, "127.0.0.1", () => console.log(`proxy listening on http://127.0.0.1:${PORT} -> https://${UPSTREAM}`));
