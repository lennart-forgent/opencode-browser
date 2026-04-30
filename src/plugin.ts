import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import net from "net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir, userInfo } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

const { schema } = tool;

const BASE_DIR = join(homedir(), ".opencode-browser");
const SOCKET_PATH = getBrokerSocketPath();
const LOG_PATH = join(BASE_DIR, "plugin.log");

function getSafePipeName(): string {
  try {
    const username = userInfo().username || "user";
    return `opencode-browser-${username}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return "opencode-browser";
  }
}

function getBrokerSocketPath(): string {
  const override = process.env.OPENCODE_BROWSER_BROKER_SOCKET;
  if (override) return override;
  if (process.platform === "win32") return `\\\\.\\pipe\\${getSafePipeName()}`;
  return join(BASE_DIR, "broker.sock");
}

mkdirSync(BASE_DIR, { recursive: true });

function logDebug(message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // ignore
  }
}

logDebug(`plugin loaded v${getPackageVersion()} pid=${process.pid} socket=${SOCKET_PATH}`);

const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env.OPENCODE_BROWSER_MAX_UPLOAD_BYTES;
  const value = raw ? Number(raw) : NaN;
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_MAX_UPLOAD_BYTES;
})();

function resolveUploadPath(filePath: string): string {
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  if (!trimmed) throw new Error("filePath is required");
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

function buildFileUploadPayload(
  filePath: string,
  fileName?: string,
  mimeType?: string
): { name: string; mimeType?: string; base64: string } {
  const absPath = resolveUploadPath(filePath);
  const stats = statSync(absPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${absPath}`);
          if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${stats.size} bytes). Max is ${MAX_UPLOAD_BYTES} bytes (OPENCODE_BROWSER_MAX_UPLOAD_BYTES).`
    );
  }
  const base64 = readFileSync(absPath).toString("base64");
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim() : basename(absPath);
  const mt = typeof mimeType === "string" && mimeType.trim() ? mimeType.trim() : undefined;
  return { name, mimeType: mt, base64 };
}

type BrokerResponse =
  | { type: "response"; id: number; ok: true; data: any }
  | { type: "response"; id: number; ok: false; error: string };

function createJsonLineParser(onMessage: (msg: any) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  };
}

function writeJsonLine(socket: net.Socket, msg: any): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function maybeStartBroker(): void {
  const brokerPath = join(BASE_DIR, "broker.cjs");
  if (!existsSync(brokerPath)) return;

  try {
    const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // ignore
  }
}

async function connectToBroker(): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => {
      lastBrokerError = err instanceof Error ? err : new Error(String(err));
      logDebug(`broker connect error socket=${SOCKET_PATH} error=${lastBrokerError.message}`);
      reject(err);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

let socket: net.Socket | null = null;
let lastBrokerError: Error | null = null;
let sessionId = Math.random().toString(36).slice(2);
let reqId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

async function ensureBrokerSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;

  // Try to connect; if missing, try to start broker and retry.
  try {
    socket = await connectToBroker();
  } catch {
    maybeStartBroker();
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      try {
        socket = await connectToBroker();
        break;
      } catch {}
    }
  }

  if (!socket || socket.destroyed) {
    const errorMessage = lastBrokerError?.message ? ` (${lastBrokerError.message})` : "";
    throw new Error(
      `Could not connect to local broker at ${SOCKET_PATH}${errorMessage}. ` +
        "Run `npx @different-ai/opencode-browser install` and ensure the extension is loaded."
    );
  }

  socket.setNoDelay(true);
  logDebug(`broker connected socket=${SOCKET_PATH}`);
  socket.on(
    "data",
    createJsonLineParser((msg) => {
      if (msg?.type !== "response" || typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const res = msg as BrokerResponse;
      if (!res.ok) p.reject(new Error(res.error));
      else p.resolve(res.data);
    })
  );

  socket.on("close", () => {
    socket = null;
  });

  socket.on("error", () => {
    socket = null;
  });

  writeJsonLine(socket, { type: "hello", role: "plugin", sessionId, pid: process.pid });

  return socket;
}

async function brokerRequest(op: string, payload: Record<string, any>): Promise<any> {
  const s = await ensureBrokerSocket();
  const id = ++reqId;

  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeJsonLine(s, { type: "request", id, op, ...payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("Timed out waiting for broker response"));
    }, 60000);
  });
}

async function brokerOnlyRequest(op: string, payload: Record<string, any>): Promise<any> {
  return await brokerRequest(op, payload);
}

function toolResultText(data: any, fallback: string): string {
  if (typeof data?.content === "string") return data.content;
  if (typeof data === "string") return data;
  if (data?.content != null) return JSON.stringify(data.content);
  return fallback;
}

async function toolRequest(toolName: string, args: Record<string, any>): Promise<any> {
  return await brokerRequest("tool", { tool: toolName, args });
}

async function statusRequest(): Promise<any> {
  return await brokerRequest("status", {});
}

const plugin: Plugin = async (ctx) => {

  return {
    tool: {
      browser_debug: tool({
        description: "Debug plugin loading and connection status.",
        args: {},
        async execute(args, ctx) {
          const lines = [
            "loaded: true",
            `sessionId: ${sessionId}`,
            `pid: ${process.pid}`,
            `backend: extension`,
            `brokerSocket: ${SOCKET_PATH}`,
            `pluginVersion: ${getPackageVersion()}`,
            `timestamp: ${new Date().toISOString()}`,
          ];
          return lines.join("\n");
        },
      }),

      browser_version: tool({
        description: "Return the installed @different-ai/opencode-browser plugin version.",
        args: {},
        async execute(args, ctx) {
          return JSON.stringify({
            name: "@different-ai/opencode-browser",
            version: getPackageVersion(),
            sessionId,
            pid: process.pid,
            backend: "extension",
          });
        },
      }),

      browser_status: tool({
        description: "Check backend connection status and current tab claims.",
        args: {},
        async execute(args, ctx) {
          const data = await statusRequest();
          return JSON.stringify(data);
        },
      }),

      browser_get_tabs: tool({
        description: "List all open browser tabs",
        args: {},
        async execute(args, ctx) {
          const data = await toolRequest("get_tabs", {});
          return toolResultText(data, "ok");
        },
      }),

      browser_list_claims: tool({
        description: "List tab ownership claims",
        args: {},
        async execute(args, ctx) {
          const data = await brokerOnlyRequest("list_claims", {});
          return JSON.stringify(data);
        },
      }),

      browser_claim_tab: tool({
        description: "Claim a browser tab for this session",
        args: {
          tabId: schema.number(),
          force: schema.boolean().optional(),
        },
        async execute({ tabId, force }, ctx) {
          const data = await brokerOnlyRequest("claim_tab", { tabId, force });
          return JSON.stringify(data);
        },
      }),

      browser_release_tab: tool({
        description: "Release a claimed browser tab",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }, ctx) {
          const data = await brokerOnlyRequest("release_tab", { tabId });
          return JSON.stringify(data);
        },
      }),

      browser_open_tab: tool({
        description: "Open a new browser tab",
        args: {
          url: schema.string().optional(),
          active: schema.boolean().optional(),
        },
        async execute({ url, active }, ctx) {
          const data = await toolRequest("open_tab", { url, active });
          return toolResultText(data, "Opened new tab");
        },
      }),

      browser_close_tab: tool({
        description: "Close a browser tab owned by this session",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("close_tab", { tabId });
          return toolResultText(data, "Closed tab");
        },
      }),

      browser_navigate: tool({
        description: "Navigate to a URL in the browser",
        args: {
          url: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ url, tabId }, ctx) {
          const data = await toolRequest("navigate", { url, tabId });
          return toolResultText(data, `Navigated to ${url}`);
        },
      }),

      browser_click: tool({
        description: "Click at specific x, y coordinates on the page",
        args: {
          x: schema.number(),
          y: schema.number(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, tabId }, ctx) {
          const data = await toolRequest("click", { x, y, tabId });
          return toolResultText(data, `Clicked at (${x}, ${y})`);
        },
      }),

      browser_type: tool({
        description: "Type text into the currently focused element",
        args: {
          text: schema.string(),
          clear: schema.boolean().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ text, clear, tabId }, ctx) {
          const data = await toolRequest("type", { text, clear, tabId });
          return toolResultText(data, `Typed "${text}"`);
        },
      }),

      browser_screenshot: tool({
        description: "Take a screenshot of the current page. Returns base64 image data URL.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("screenshot", { tabId });
          return toolResultText(data, "Screenshot failed");
        },
      }),

      browser_scroll: tool({
        description: "Scroll the page",
        args: {
          x: schema.number().optional(),
          y: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, tabId }, ctx) {
          const data = await toolRequest("scroll", { x, y, tabId });
          return toolResultText(data, "Scrolled");
        },
      }),

      browser_wait: tool({
        description: "Wait for a specified duration",
        args: {
          ms: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ ms, tabId }, ctx) {
          const data = await toolRequest("wait", { ms, tabId });
          return toolResultText(data, "Waited");
        },
      }),

      browser_list_downloads: tool({
        description: "List recent downloads (Chrome backend).",
        args: {
          limit: schema.number().optional(),
          state: schema.string().optional(),
        },
        async execute({ limit, state }, ctx) {
          const data = await toolRequest("list_downloads", { limit, state });
          return toolResultText(data, "[]");
        },
      }),

      browser_set_file_input: tool({
        description: "Set a file input element's selected file using a local file path.",
        args: {
          x: schema.number(),
          y: schema.number(),
          filePath: schema.string(),
          fileName: schema.string().optional(),
          mimeType: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, filePath, fileName, mimeType, tabId }, ctx) {
          const file = buildFileUploadPayload(filePath, fileName, mimeType);
          const data = await toolRequest("set_file_input", {
            x,
            y,
            tabId,
            files: [file],
          });
          return toolResultText(data, "Set file input");
        },
      }),

      browser_console: tool({
        description:
          "Read console log messages from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
          filter: schema.string().optional(),
        },
        async execute({ tabId, clear, filter }, ctx) {
          const data = await toolRequest("console", { tabId, clear, filter });
          return toolResultText(data, "[]");
        },
      }),

      browser_errors: tool({
        description:
          "Read JavaScript errors from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
        },
        async execute({ tabId, clear }, ctx) {
          const data = await toolRequest("errors", { tabId, clear });
          return toolResultText(data, "[]");
        },
      }),
    },
  };
};

export default plugin;
