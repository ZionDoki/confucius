import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function until(work, timeout = 60_000, interval = 150) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try {
      const result = await work();
      if (result) return result;
    } catch (caught) {
      error = caught;
    }
    await delay(interval);
  }
  throw error ?? new Error(`Acceptance wait timed out after ${timeout} ms`);
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export class Rdp {
  buffer = Buffer.alloc(0);
  queue = [];
  waiters = new Set();
  constructor(port) {
    this.socket = net.connect(port, "127.0.0.1");
    this.socket.on("error", () => {});
    this.socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      for (;;) {
        const colon = this.buffer.indexOf(58);
        if (colon < 0) return;
        const length = Number(this.buffer.subarray(0, colon));
        if (this.buffer.length < colon + 1 + length) return;
        const message = JSON.parse(
          this.buffer.subarray(colon + 1, colon + 1 + length),
        );
        this.buffer = this.buffer.subarray(colon + 1 + length);
        const waiter = [...this.waiters].find((item) => item.match(message));
        if (waiter) {
          this.waiters.delete(waiter);
          waiter.resolve(message);
        } else this.queue.push(message);
      }
    });
  }
  async next(match, timeout = 120_000) {
    const index = this.queue.findIndex(match);
    if (index >= 0) return this.queue.splice(index, 1)[0];
    let item, timer;
    try {
      return await new Promise((resolve, reject) => {
        item = { match, resolve };
        this.waiters.add(item);
        timer = setTimeout(
          () => reject(new Error("RDP response timed out")),
          timeout,
        );
      });
    } finally {
      clearTimeout(timer);
      this.waiters.delete(item);
    }
  }
  request(to, type, extra = {}) {
    const reply = this.next(
      (m) =>
        m.from === to &&
        ![
          "evaluationResult",
          "frameUpdate",
          "tabNavigated",
          "resources-available-array",
        ].includes(m.type),
    );
    const text = JSON.stringify({ to, type, ...extra });
    this.socket.write(Buffer.byteLength(text) + ":" + text);
    return reply;
  }
  async connect() {
    await this.next((m) => m.from === "root");
    const descriptor = await this.request("root", "getProcess", { id: 0 });
    const target = await this.request(
      descriptor.processDescriptor.actor,
      "getTarget",
    );
    this.actor = target.process.consoleActor;
  }
  async evaluate(source, timeout = 120_000) {
    const receipt = await this.request(this.actor, "evaluateJSAsync", {
      text: `(async()=>{try {return JSON.stringify({ok:true,value:await(async()=>{${source}\n})()});}catch(e){return JSON.stringify({ok:false,error:String(e),stack:e?.stack});}})()`,
      mapped: { await: true },
      disableBreaks: true,
    });
    const message = await this.next(
      (m) => m.type === "evaluationResult" && m.resultID === receipt.resultID,
      timeout,
    );
    if (message.hasException || message.topLevelAwaitRejected)
      throw new Error(message.exceptionMessage ?? "RDP evaluation rejected");
    let text = message.result;
    if (text?.type === "longString")
      text = (
        await this.request(text.actor, "substring", {
          start: 0,
          end: text.length,
        })
      ).substring;
    const result = JSON.parse(text);
    if (!result.ok) throw new Error(`${result.error}\n${result.stack ?? ""}`);
    return result.value;
  }
  close() {
    this.socket.destroy();
  }
}

export function parsePreferences(source) {
  const prefs = {};
  for (const match of source.matchAll(/user_pref\("([^"]+)",\s*(.+?)\);/g)) {
    try {
      prefs[match[1]] = JSON.parse(match[2]);
    } catch {
      /* Unrelated syntax. */
    }
  }
  return prefs;
}

// Attach only after verifying the exact isolated profile/data paths in the running process.
export async function attachIsolated(state) {
  const prefs = parsePreferences(
    await readFile(join(state.profile, "user.js"), "utf8"),
  );
  const instance = new IsolatedZotero({
    ...state,
    token: prefs["extensions.zotero.confucius.pairingToken"],
  });
  instance.rdp = new Rdp(state.rdpPort);
  await instance.rdp.connect();
  await instance.rdp.evaluate(
    `if(PathUtils.profileDir!==${JSON.stringify(state.profile)}||Zotero.DataDirectory.dir!==${JSON.stringify(state.data)})throw new Error("Wrong isolated instance");return true;`,
  );
  return instance;
}

export class IsolatedZotero {
  constructor(options) {
    Object.assign(this, options);
  }
  static async create({
    root,
    binary,
    xpi,
    sourcePreferences,
    prefix = "windows-acceptance-",
  }) {
    const directory = await mkdtemp(
      join(root, "apps/zotero-addon/.scaffold", prefix),
    );
    const profile = join(directory, "profile"),
      data = join(directory, "data");
    await mkdir(join(profile, "extensions"), { recursive: true });
    await mkdir(data);
    await copyFile(
      xpi,
      join(profile, "extensions/confucius@zotero.plugin.xpi"),
    );
    const token = randomUUID(),
      httpPort = await freePort();
    const inherited = {};
    if (sourcePreferences) {
      const source = parsePreferences(
        await readFile(sourcePreferences, "utf8"),
      );
      for (const name of [
        "endpointsJson",
        "activeEndpointId",
        "baseUrl",
        "apiKey",
        "model",
        "maxTokens",
        "contextWindowTokens",
        "reasoningEffort",
        "streamResponses",
        "codexExecutable",
        "kimiExecutable",
      ]) {
        const key = `extensions.zotero.confucius.${name}`;
        if (source[key] !== undefined) inherited[key] = source[key];
      }
    }
    const prefs = {
      ...inherited,
      "extensions.zotero.firstRun2": false,
      "extensions.zotero.firstRunGuidance": false,
      "extensions.zotero.firstRun.skipFirefoxProfileAccessCheck": true,
      "extensions.zoteroWinWordIntegration.skipInstallation": true,
      "extensions.zoteroOpenOfficeIntegration.skipInstallation": true,
      "extensions.zotero.httpServer.enabled": true,
      "extensions.zotero.httpServer.port": httpPort,
      "extensions.zotero.confucius.pairingToken": token,
      "extensions.zotero.confucius.updateAutoCheck": false,
      "extensions.zotero.confucius.memoryConsent": "off",
      "extensions.zotero.confucius.uiLanguage": "zh-CN",
      "extensions.autoDisableScopes": 0,
      "extensions.enabledScopes": 5,
      "extensions.update.enabled": false,
      "devtools.debugger.remote-enabled": true,
      "devtools.debugger.prompt-connection": false,
    };
    await writeFile(
      join(profile, "user.js"),
      Object.entries(prefs)
        .map(
          ([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`,
        )
        .join("\n"),
      { mode: 0o600 },
    );
    // Tokens and model credentials remain in the isolated profile, never in reports.
    return new IsolatedZotero({
      root,
      binary,
      directory,
      profile,
      data,
      httpPort,
      token,
    });
  }
  async launch() {
    if (this.child && this.child.exitCode === null && !this.child.signalCode)
      throw new Error("Test Zotero already running");
    this.rdpPort = await freePort();
    const log = await open(
      join(this.directory, `zotero-${Date.now()}.log`),
      "a",
      0o600,
    );
    this.child = spawn(
      this.binary,
      [
        "--purgecaches",
        "-no-remote",
        "-profile",
        this.profile,
        "--dataDir",
        this.data,
        "-start-debugger-server",
        String(this.rdpPort),
      ],
      { stdio: ["ignore", log.fd, log.fd], windowsHide: true },
    );
    this.child.on("error", (error) => {
      this.launchError = error;
    });
    await log.close();
    await until(async () => {
      if (this.launchError) throw this.launchError;
      return new Promise((done) => {
        const socket = net.connect(this.rdpPort, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          done(true);
        });
        socket.once("error", () => done(false));
      });
    });
    this.rdp = new Rdp(this.rdpPort);
    await this.rdp.connect();
    this.environment = await until(() =>
      this.rdp.evaluate(`
      if (!Zotero.Confucius?.data.initialized) return false;
      if (Zotero.DataDirectory.dir !== ${JSON.stringify(this.data)} || PathUtils.profileDir !== ${JSON.stringify(this.profile)}) throw new Error("Unexpected profile; test writes refused");
      const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon=await AddonManager.getAddonByID("confucius@zotero.plugin");
      return {zotero:Zotero.version,version:addon.version,temporary:addon.temporarilyInstalled,profile:PathUtils.profileDir,localProfile:PathUtils.localProfileDir,data:Zotero.DataDirectory.dir,pid:Services.appinfo.processID};
    `),
    );
    return this.environment;
  }
  async rpc(method, params = {}, timeout = 120_000) {
    const response = await fetch(
      `http://127.0.0.1:${this.httpPort}/confucius/v1/rpc`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method,
          params,
        }),
        signal: AbortSignal.timeout(timeout),
      },
    );
    const body = await response.json();
    if (!response.ok || body.error)
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    return body.result;
  }
  async stop({ graceful = false } = {}) {
    if (!this.rdp) return;
    const pid = await this.rdp.evaluate(
      `if(PathUtils.profileDir!==${JSON.stringify(this.profile)}||Zotero.DataDirectory.dir!==${JSON.stringify(this.data)})throw new Error("Wrong test profile");return Services.appinfo.processID;`,
    );
    // Windows can relaunch the spawned executable. Verify the actual process
    // through this isolated profile's RDP connection before stopping it.
    if (graceful) {
      await this.rdp.evaluate(
        "await Zotero.Confucius.hooks.host.persistNow(); Zotero.setTimeout(()=>Zotero.Utilities.Internal.quit(0), 100); return true;",
      );
    } else process.kill(pid, "SIGKILL");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 20000);
    this.rdp?.close();
    this.rdp = null;
  }
  publicState() {
    return {
      directory: this.directory,
      profile: this.profile,
      data: this.data,
      httpPort: this.httpPort,
      rdpPort: this.rdpPort,
      pid: this.environment?.pid ?? this.child?.pid,
      environment: this.environment,
    };
  }
}
