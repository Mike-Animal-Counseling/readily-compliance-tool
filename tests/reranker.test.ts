import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { isLocalRerankerConfigured, scoreLocalReranker } from "../lib/evidence/reranker";

const question = "How long must notices be retained?";
const passages = [
  { key: "policy-version-a/child-1", text: "The notices must be in writing." },
  { key: "policy-version-a/child-2", text: "Retain notices for 90 days." },
];

async function mockReranker(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const token = randomBytes(32).toString("base64url");
  const version = "bge-reranker-v2-m3@fixture";
  const settings = {
    READILY_V1_RERANK_PORT: String((server.address() as AddressInfo).port),
    READILY_V1_RERANK_TOKEN: token,
    READILY_V1_RERANK_MODEL: version,
  };
  const previous = Object.keys(settings).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return { server, token, version };
}

test("local reranker authenticates, sends child text only and aligns scores by input index", async t => {
  let received: { method?: string; url?: string; authorization?: string; body: unknown } | undefined;
  const { token, version } = await mockReranker(t, (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received = { method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ results: [{ index: 1, relevance_score: 5.5 }, { index: 0, relevance_score: -10.2 }] }));
    });
  });
  assert.equal(isLocalRerankerConfigured(), true);
  assert.deepEqual(await scoreLocalReranker(question, passages), { scores: [-10.2, 5.5], version });
  assert.deepEqual(received, {
    method: "POST", url: "/rerank", authorization: `Bearer ${token}`,
    body: { model: version, query: question, documents: passages.map(passage => passage.text), top_n: 2 },
  });
});

test("local reranker falls back for invalid config, oversized input, redirects and invalid results", async t => {
  let calls = 0;
  const replies = [
    { status: 307, location: "/other-endpoint", body: "" },
    { status: 503, body: "unavailable" },
    { status: 200, body: JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }, { index: 0, relevance_score: 0.9 }] }) },
    { status: 200, body: JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }, { index: 2, relevance_score: 0.9 }] }) },
    { status: 200, body: '{"results":[{"index":0,"relevance_score":1e309},{"index":1,"relevance_score":0}]}' },
    { status: 200, body: " ".repeat(16 * 1024 + 1) },
  ];
  const { version } = await mockReranker(t, (_req, res) => {
    const { status, location, body } = replies[calls++] ?? replies[1];
    if (location) res.setHeader("Location", location);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
  delete process.env.READILY_V1_RERANK_MODEL;
  assert.equal(isLocalRerankerConfigured(), false);
  assert.equal(await scoreLocalReranker(question, passages), null);
  process.env.READILY_V1_RERANK_MODEL = version;
  assert.equal(await scoreLocalReranker(question, [{ key: "long", text: "x".repeat(1201) }]), null);
  assert.equal(calls, 0);
  for (let index = 0; index < replies.length; index++) {
    assert.equal(await scoreLocalReranker(question, passages), null);
    assert.equal(calls, index + 1);
  }
});

test("local reranker skips concurrent requests and releases its slot on cancellation", async t => {
  let calls = 0;
  const { server, version } = await mockReranker(t, (_req, res) => {
    if (++calls === 1) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] }));
  });
  const controller = new AbortController();
  const called = once(server, "request");
  const pending = scoreLocalReranker(question, passages, controller.signal);
  await called;
  assert.equal(await scoreLocalReranker(question, passages), null);
  assert.equal(calls, 1);
  controller.abort();
  assert.equal(await pending, null);
  assert.deepEqual(await scoreLocalReranker(question, passages), { scores: [0.1, 0.9], version });
});

test("local reranker falls back when the response body stalls", { timeout: 10_000 }, async t => {
  await mockReranker(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"results":[');
  });
  assert.equal(await scoreLocalReranker(question, passages), null);
});
