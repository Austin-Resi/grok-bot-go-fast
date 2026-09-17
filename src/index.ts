import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadDotEnv } from "./load-env.ts";
import { createServer } from "./server.ts";

loadDotEnv();

void serveStdio(createServer);
console.error("crack-bot MCP server (Vercel AI Gateway → typesafe-ai/jev) running on stdio");
