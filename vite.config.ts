import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ServerResponse } from "node:http";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "nexiom-local-core",
      transformIndexHtml(html, context) {
        if (context.server) return html;
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content:
                  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'",
              },
              injectTo: "head-prepend",
            },
          ],
        };
      },
      configureServer(server) {
        const worker = fork(
          path.resolve(".build/core.cjs"),
          [path.resolve(process.env.NEXIOM_DEV_DATA_DIR ?? ".local/browser")],
          { stdio: ["ignore", "inherit", "inherit", "ipc"] },
        );
        const clients = new Set<ServerResponse>();
        const pending = new Map<
          string,
          {
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
            timer: NodeJS.Timeout;
          }
        >();
        let alive = true;
        worker.on("message", (packet: any) => {
          if (packet.type === "changed") {
            for (const client of clients) client.write("data: changed\n\n");
            return;
          }
          const item = pending.get(packet.id);
          if (!item) return;
          clearTimeout(item.timer);
          pending.delete(packet.id);
          packet.error
            ? item.reject(new Error(packet.error))
            : item.resolve(packet.result);
        });
        worker.on("exit", () => {
          alive = false;
          for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(new Error("本地核心已退出，请重启开发服务。"));
          }
          pending.clear();
          for (const client of clients) client.end();
        });
        server.httpServer?.on("close", () => {
          for (const client of clients) client.end();
          worker.kill();
        });
        server.middlewares.use("/api", async (req, res, next) => {
          const allowedHost = /^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "");
          const origin = req.headers.origin;
          if (
            !allowedHost ||
            (origin && origin !== `http://${req.headers.host}`)
          ) {
            res.writeHead(403).end();
            return;
          }
          if (req.url === "/events" && req.method === "GET") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(": connected\n\n");
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return;
          }
          if (req.url !== "/command" || req.method !== "POST") {
            next();
            return;
          }
          if (!req.headers["content-type"]?.startsWith("application/json")) {
            res.writeHead(415).end();
            return;
          }
          try {
            if (!alive) throw new Error("本地核心不可用。");
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 30000000) throw new Error("请求过大。");
              chunks.push(chunk);
            }
            const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const result = await new Promise((resolve, reject) => {
              const id = randomUUID();
              const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error("本地核心响应超时。"));
              }, 30000);
              pending.set(id, { resolve, reject, timer });
              worker.send({ id, command });
            });
            res
              .writeHead(200, { "Content-Type": "application/json" })
              .end(JSON.stringify(result));
          } catch (error) {
            res
              .writeHead(400, { "Content-Type": "application/json" })
              .end(JSON.stringify({ error: (error as Error).message }));
          }
        });
      },
    },
  ],
  server: {
    port: 5173,
    fs: {
      deny: [
        ".env",
        ".env.*",
        "**/.git/**",
        "**/.local/**",
        "**/.nexiom/**",
        "**/workspace.sqlite*",
      ],
    },
  },
  build: { outDir: "dist" },
});
