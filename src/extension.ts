import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as iconv from "iconv-lite";
import { detectEncoding } from "./encoding";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 诊断日志（输出面板 → “编码切换器”）
// Trae 偶发输出面板不落盘（整会话所有通道 0 字节），镜像一份到临时文件兜底
let log: vscode.OutputChannel;
let logFile = "";
function L(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  try {
    log?.appendLine(line);
  } catch {
    // 忽略
  }
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch {
      // 忽略
    }
  }
}

// 文本归一化：统一换行、去掉 BOM，便于与预期解码结果比对
function normalizeText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
}

function findByUri(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString()
  );
}

// 检测名 → iconv 解码名（utf8/utf-8/gb2312/gbk，unknown 由调用方先行拦截）
function decodeByDetect(filePath: string, enc: string): string | null {
  const name = enc === "gbk" || enc === "gb2312" ? enc : "utf-8";
  return decodeFileBytes(filePath, name);
}

// 带“打开日志”按钮的消息（点击显示输出面板）
function showLogMsg(
  msg: string,
  kind: "info" | "warn" | "error" = "info"
): void {
  const show =
    kind === "warn"
      ? vscode.window.showWarningMessage
      : kind === "error"
        ? vscode.window.showErrorMessage
        : vscode.window.showInformationMessage;
  void show(msg, "打开日志").then((c) => {
    if (c === "打开日志") {
      log.show();
    }
  });
}

// 将字符串以指定编码写回文件（Node Buffer 不支持 gbk/gb2312，统一用 iconv-lite）
function writeFileWithEncoding(
  filePath: string,
  text: string,
  encoding: string
): boolean {
  try {
    const buf = iconv.encode(text, encoding);
    fs.writeFileSync(filePath, buf);
    return true;
  } catch {
    return false;
  }
}

// 按源编码读取磁盘字节为字符串（保证中文不丢，不依赖当前可能乱码的视图）
function decodeFileBytes(filePath: string, encoding: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    let text = iconv.decode(buf, encoding);
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1); // 去 UTF-8 BOM
    }
    return text;
  } catch {
    return null;
  }
}

// ===== 前提：启用内核自带的“自动猜测编码” =====
//
// 本环境（Trae SOLO 内核）已移除 workbench.action.reopenWithEncoding 命令，
// 内核读取文件的流程支持 files.autoGuessEncoding + files.candidateGuessEncodings，
// 且 gb2312 是可猜测编码（guessableName: "GB2312"）。
// 因此：打开文件时由内核自动识别编码，扩展只负责“关闭→重开”触发重新解码。
const REQUIRED_CANDIDATES = ["utf8", "gb2312", "gb18030"];

async function ensureAutoGuessEncoding(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration("files");
    const autoInspect = cfg.inspect<boolean>("autoGuessEncoding");
    const candInspect = cfg.inspect<string[]>("candidateGuessEncodings");
    const alreadyAuto =
      autoInspect?.globalValue === true || autoInspect?.workspaceValue === true;
    const cur = candInspect?.globalValue ?? [];
    const merged = [...cur];
    for (const c of REQUIRED_CANDIDATES) {
      if (!merged.includes(c)) {
        merged.push(c);
      }
    }
    if (!alreadyAuto) {
      await cfg.update("autoGuessEncoding", true, vscode.ConfigurationTarget.Global);
    }
    if (merged.length !== cur.length) {
      await cfg.update(
        "candidateGuessEncodings",
        merged,
        vscode.ConfigurationTarget.Global
      );
    }
    L(
      `自动猜测编码设置已就绪：autoGuessEncoding=true, candidates=[${merged.join(", ")}]`
    );
  } catch (e) {
    L(`写入自动猜测编码设置失败: ${String(e)}`);
  }
}

// ===== 工作区回退编码：短中文 GB 文件防乱码的根治手段 =====
//
// 内核打开文件的流程：autoGuessEncoding 先猜；置信度不足时回退到 files.encoding
// （未设置时默认 utf8——这正是 Eeprom.h 这类只有几个汉字的短中文 GB 文件被误按
// utf8 打开的根因）。本项目规范为 GBK，把工作区回退编码设为 gb2312 后：
//   - 短中文 GB 文件：猜测低置信 → 回退 gb2312 → 恒正确；
//   - UTF-8 文件：多字节强信号置信度高 → 仍走猜测，不受影响。
// 用户已在工作区显式设置 files.encoding 时尊重不覆盖；可用配置关闭。
async function ensureWorkspaceEncoding(): Promise<void> {
  try {
    const on = vscode.workspace
      .getConfiguration("encoding-switcher")
      .get<boolean>("autoWorkspaceEncoding", true);
    if (!on) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration("files");
    const inspect = cfg.inspect<string>("encoding");
    if (inspect?.workspaceValue !== undefined) {
      L(`工作区已显式设置 files.encoding=${inspect.workspaceValue}，不覆盖`);
      return;
    }
    await cfg.update("encoding", "gb2312", vscode.ConfigurationTarget.Workspace);
    L("已设置工作区回退编码 files.encoding=gb2312（短中文保护，可经 encoding-switcher.autoWorkspaceEncoding 关闭）");
  } catch (e) {
    L(`设置工作区回退编码失败: ${String(e)}`);
  }
}

// ===== 保存拦截：乱码视图禁止写盘 =====
//
// 内核误解码时视图中的中文变成 U+FFFD 替换符；此时 Ctrl+S 会把替换符固化进磁盘
// （Eeprom.h“函数声明”→“锟斤拷”事故的根因）。磁盘本身完好而视图含 U+FFFD 时
// 取消保存并提示；磁盘已损坏则放行（文件已坏，拦截没有意义）。
function registerSaveGuard(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      const doc = e.document;
      if (doc.uri.scheme !== "file") {
        return;
      }
      const name = path.basename(doc.uri.fsPath).toLowerCase();
      if (!name.endsWith(".c") && !name.endsWith(".h")) {
        return;
      }
      if (!doc.getText().includes("\uFFFD")) {
        return;
      }
      const p = doc.uri.fsPath;
      const gb = decodeFileBytes(p, "gbk");
      const utf8 = decodeFileBytes(p, "utf-8");
      const diskClean =
        (gb !== null && !gb.includes("\uFFFD")) ||
        (utf8 !== null && !utf8.includes("\uFFFD"));
      if (!diskClean) {
        return;
      }
      e.waitUntil(
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new vscode.CancellationError()), 50);
        })
      );
      L(`已拦截乱码保存（视图含 U+FFFD 而磁盘完好）：${p}`);
      showLogMsg(
        "已阻止保存：当前视图为乱码（编码误判），保存会把乱码固化进磁盘。请关闭该文件后重新打开，或使用编码切换按钮。",
        "warn"
      );
    })
  );
}

// ===== 核心：关闭→重开，并用“实际显示内容”验证 =====
//
// 验证分两级：
//   1) 内容比对：轮询读取 doc.getText() 与“按正确编码解码出的文本”比对；
//   2) 内核检查：doc.encoding 报告的编码 id 应与目标编码一致（expectedEncIds）。
// 重开期间配合 withForcedEncoding 锁定内核解码编码，使重开直接按目标编码打开。
async function reopenDisplayedCorrectly(
  uri: vscode.Uri,
  expectedText: string,
  maxAttempts = 2,
  fast = false,
  expectedEncIds?: string[]
): Promise<boolean> {
  // 有未保存修改时拒绝（避免丢失用户编辑）
  const d0 = findByUri(uri);
  if (d0 && d0.isDirty) {
    L(`放弃重开：${uri.fsPath} 有未保存修改`);
    return false;
  }

  const expect = normalizeText(expectedText);
  if (!expect) {
    L(`无需重开：${uri.fsPath} 内容为空`);
    return true;
  }

  // 轮询等待：重开是异步的，需等新模型就绪；内容与预期一致才算成功。
  // 二次校验（内核检查）：doc.encoding（VS Code 1.83+ 提供）应与目标编码一致；
  // 纯 ASCII 文件各编码解码相同，内核编码标识可能不同，跳过该校验放行。
  const expectAscii = !/[^\x00-\x7f]/.test(expect);
  let encMismatchLogged = false;
  const displayedOK = async (maxPolls: number): Promise<boolean> => {
    for (let i = 0; i < maxPolls; i++) {
      await sleep(120);
      const d = findByUri(uri);
      if (!d || d.isDirty) {
        continue;
      }
      if (normalizeText(d.getText()) !== expect) {
        continue;
      }
      const rawEnc = (d as unknown as { encoding?: unknown }).encoding;
      const docEnc =
        typeof rawEnc === "string" ? rawEnc.toLowerCase() : "";
      if (expectedEncIds && docEnc && !expectAscii) {
        if (!expectedEncIds.includes(docEnc)) {
          if (!encMismatchLogged) {
            encMismatchLogged = true;
            L(
              `内核编码报告不符：期望 ${expectedEncIds.join("/")}，内核报告 ${docEnc}（${uri.fsPath}）`
            );
          }
          continue;
        }
        L(`内核检查通过（编码=${docEnc}）：${uri.fsPath}`);
      }
      return true;
    }
    return false;
  };

  // 已经正确显示（打开时已被内核猜对）。
  // 多轮询几次：文档刚打开可能尚未加载完，立即判定会误判并触发无谓的重开刷新
  // 批量场景用 fast 档：文件多，缩短单个文件的队列耗时
  if (await displayedOK(fast ? 4 : 10)) {
    L(`显示已正确：${uri.fsPath}`);
    return true;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 关闭该 uri 的所有标签页，释放旧解码缓存的文档模型。
    // tabGroups.close 后台关闭全程不抢焦点（修复“异常跳转文件”）
    let closed = 0;
    try {
      const tabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter(
          (t) =>
            t.input instanceof vscode.TabInputText &&
            t.input.uri.toString() === uri.toString()
        );
      if (tabs.length > 0) {
        await vscode.window.tabGroups.close(tabs, true);
        closed = tabs.length;
      }
    } catch (e) {
      L(`关闭标签异常（第${attempt}次）: ${String(e)}`);
    }
    // 等待旧文档模型真正销毁（textDocuments 中不再包含该 uri），
    // 未释放就重开会命中旧缓存，导致重开无效、反复刷新
    let released = false;
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if (!findByUri(uri)) {
        released = true;
        break;
      }
    }
    L(
      `第${attempt}次：关闭${closed}个编辑器，模型${released ? "已释放" : "未及时释放（继续尝试）"}`
    );

    let reopened = false;
    try {
      const nd = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(nd, { preview: false });
      reopened = true;
    } catch (e) {
      L(`重开异常（第${attempt}次）: ${String(e)}`);
    }
    if (reopened && (await displayedOK(fast ? 10 : 20))) {
      L(`第${attempt}次关闭重开后显示正确：${uri.fsPath}`);
      return true;
    }
    L(`第${attempt}次关闭重开后仍未正确显示：${uri.fsPath}`);
  }

  L(`全部重开策略失败：${uri.fsPath}`);
  return false;
}

// 转换互斥锁：手动单文件转换与批量转换共用。
// 快速连点或批量进行中再触发，会让两次“关-重开”互相拆台（双双重开失败）
let convertBusy = false;
async function convertTo(targetEnc: string): Promise<void> {
  if (convertBusy) {
    L(`忽略重复触发：上一次转换（${metaOf(targetEnc).label}）尚未完成`);
    vscode.window.showInformationMessage("编码转换正在进行中，请稍候再试");
    return;
  }
  convertBusy = true;
  try {
    await doConvert(targetEnc);
  } finally {
    convertBusy = false;
  }
}

// 将当前文件从源编码转为目标编码并保存（按源编码正确解码，避免中文乱码）
async function doConvert(targetEnc: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("当前没有打开的编辑器");
    return;
  }
  const doc = editor.document;

  if (doc.isUntitled) {
    vscode.window.showWarningMessage("未保存的新文件无法转换，请先保存");
    return;
  }
  if (doc.uri.scheme !== "file") {
    vscode.window.showWarningMessage("当前不是本地文件，无法转换编码");
    return;
  }
  if (doc.isDirty) {
    vscode.window.showWarningMessage(
      "文件有未保存修改，请先保存（Ctrl+S）后再转换编码"
    );
    return;
  }

  const filePath = doc.uri.fsPath;

  // 1) 检测文件真实编码
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    vscode.window.showErrorMessage(`无法读取文件：${filePath}`);
    return;
  }
  const srcEnc = detectEncoding(bytes);

  // 2) 按源编码正确解码磁盘字节
  if (srcEnc === "unknown") {
    vscode.window.showWarningMessage(
      "无法判断当前文件编码（非 GB2312 / UTF-8），未做转换"
    );
    return;
  }
  const text = decodeByDetect(filePath, srcEnc);
  if (text === null) {
    vscode.window.showErrorMessage(`读取源文件失败（编码：${srcEnc}）`);
    return;
  }

  // 3) 以目标编码写回（UTF-8 不写 BOM）
  if (!writeFileWithEncoding(filePath, text, targetEnc)) {
    vscode.window.showErrorMessage(`切换为 ${metaOf(targetEnc).label} 失败`);
    return;
  }

  // 转换成功后记录新指纹，避免自动检测重复干预
  autoDone.set(doc.uri.toString(), diskFingerprint(doc.uri));

  // 写盘后立即复检磁盘编码（排查外部同步/回写类异常，保留诊断证据）
  try {
    const rb = fs.readFileSync(filePath);
    L(`写盘复检：磁盘编码=${detectEncoding(rb)}，字节数=${rb.length}`);
  } catch {
    // 忽略
  }

  // 等待文件监听处理完外部写入，再关闭重开触发重新解码
  await sleep(400);

  // 4) 关闭重开并验证显示内容（走串行队列：与自动重开/批量转换互斥）。
  //    重开期间临时锁定内核解码编码为目标编码，重开不依赖猜测、直接正确显示
  L(`转换完成：${filePath} ${srcEnc} → ${targetEnc}，开始重开验证`);
  let ok = false;
  try {
    await enqueueAuto(async () => {
      ok = await withForcedEncoding(targetEnc, () =>
        reopenDisplayedCorrectly(doc.uri, text, 2, false, metaOf(targetEnc).ids)
      );
    });
  } catch (e) {
    L(`重开过程异常: ${String(e)}`);
    ok = false;
  }
  if (!ok) {
    showLogMsg(
      `已转换为 ${metaOf(targetEnc).label} 并保存到磁盘，但视图未能自动刷新为新编码。请手动关闭该文件后重新打开。可到输出面板「编码切换器」查看诊断日志。`,
      "error"
    );
    return;
  }

  // 5) 刷新按键显示（文件编码已改变）
  await updateContext();
  vscode.window.showInformationMessage(
    `已切换为 ${metaOf(targetEnc).label} 并保存`
  );
}

// 根据当前活动编辑器文件编码，更新上下文变量控制显示哪个按键
async function updateContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let isGb2312 = false;
  let isUtf8 = false;
  // 仅 .c/.h 源文件显示按键（本扩展的目标场景）
  let isSource = false;
  if (
    editor &&
    !editor.document.isUntitled &&
    editor.document.uri.scheme === "file"
  ) {
    const lower = editor.document.uri.fsPath.toLowerCase();
    isSource = lower.endsWith(".c") || lower.endsWith(".h");
    try {
      const bytes = fs.readFileSync(editor.document.uri.fsPath);
      const enc = detectEncoding(bytes);
      if (enc === "gb2312" || enc === "gbk") {
        isGb2312 = true;
      } else if (enc === "utf8" || enc === "utf-8") {
        isUtf8 = true;
      }
    } catch {
      // 忽略
    }
  }
  for (const [key, val] of Object.entries({
    "encoding-switcher:isGb2312": isGb2312,
    "encoding-switcher:isUtf8": isUtf8,
    "encoding-switcher:isSource": isSource,
  })) {
    await vscode.commands.executeCommand("setContext", key, val);
  }
}

// ===== 自动检测：打开 GB2312/GBK 文件时自动按正确编码重开，避免乱码 =====

// 已处理指纹表：uri → “磁盘大小:mtimeMs”。
// 重开后会再次触发 onDidOpenTextDocument（同一个文件、同样字节），
// 指纹相同则跳过 —— 防止反复重开的根本手段。
const autoDone = new Map<string, string>();

function diskFingerprint(uri: vscode.Uri): string {
  try {
    const st = fs.statSync(uri.fsPath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return String(Date.now());
  }
}

// 串行队列：多个文件的自动重开逐个执行，避免互相干扰（激活编辑器抢焦点）。
// 手动转换的重开验证也走此队列，与自动/批量互斥，防止并发关-开互相拆台
let autoChain: Promise<void> = Promise.resolve();
function enqueueAuto(task: () => Promise<void>): Promise<void> {
  autoChain = autoChain.then(task).catch(() => {});
  return autoChain;
}

// ===== 重开期间临时锁定内核解码编码 =====
// 内核重开/重读文件时会重新猜测编码，对短中文文件不稳定（可能猜成 utf8）。
// 此 helper 在重开期间临时关闭自动猜测并把 files.encoding 设为目标编码，
// 使重开 100% 按目标编码解码，结束后立即恢复原设置。
// 注意：ensureWorkspaceEncoding 会把回退编码写在【工作区级】，而工作区设置
// 覆盖全局设置——锁定必须同时覆盖 Global+Workspace 两个层级，否则会被
// 工作区级 gb2312 压掉导致“转换到 UTF-8 后重开锁定失效”。
async function withForcedEncoding<T>(
  target: string,
  fn: () => Promise<T>
): Promise<T> {
  const filesCfg = vscode.workspace.getConfiguration("files");
  const forced = metaOf(target).forced;
  // 记录两个层级的原值（undefined = 该层级未设置，恢复时传 undefined 即删除）
  const prevGuessG = filesCfg.inspect<boolean>("autoGuessEncoding")?.globalValue;
  const prevGuessW = filesCfg.inspect<boolean>("autoGuessEncoding")?.workspaceValue;
  const prevEncG = filesCfg.inspect<string>("encoding")?.globalValue;
  const prevEncW = filesCfg.inspect<string>("encoding")?.workspaceValue;
  try {
    await filesCfg.update("autoGuessEncoding", false, vscode.ConfigurationTarget.Global);
    await filesCfg.update("autoGuessEncoding", false, vscode.ConfigurationTarget.Workspace);
    await filesCfg.update("encoding", forced, vscode.ConfigurationTarget.Global);
    await filesCfg.update("encoding", forced, vscode.ConfigurationTarget.Workspace);
    L(`已临时锁定重开编码为 ${forced}（Global+Workspace 双层级）`);
  } catch (e) {
    L(`锁定重开编码失败（按猜测重开）: ${String(e)}`);
  }
  try {
    return await fn();
  } finally {
    try {
      await filesCfg.update("autoGuessEncoding", prevGuessG ?? true, vscode.ConfigurationTarget.Global);
      await filesCfg.update("autoGuessEncoding", prevGuessW, vscode.ConfigurationTarget.Workspace);
      await filesCfg.update("encoding", prevEncG, vscode.ConfigurationTarget.Global);
      await filesCfg.update("encoding", prevEncW, vscode.ConfigurationTarget.Workspace);
      L(
        `已恢复编码设置（guess: 全局=${prevGuessG ?? "默认"}/工作区=${prevGuessW ?? "未设"}, encoding: 全局=${prevEncG ?? "默认"}/工作区=${prevEncW ?? "未设"}）`
      );
    } catch (e) {
      L(`恢复编码设置失败: ${String(e)}`);
    }
  }
}

function scheduleAutoReopen(uri: vscode.Uri): void {
  enqueueAuto(async () => {
    await sleep(250); // 等待打开事件尘埃落定
    const key = uri.toString();
    const fp = diskFingerprint(uri);
    if (autoDone.get(key) === fp) {
      return; // 已处理过且文件未变化
    }
    const d = findByUri(uri);
    if (!d || d.isDirty || d.uri.scheme !== "file") {
      return;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(uri.fsPath);
    } catch {
      return;
    }
    const enc = detectEncoding(bytes);
    if (enc !== "gb2312" && enc !== "gbk") {
      // ===== 内核猜错纠偏（UTF-8 视图不匹配检测） =====
      // 磁盘为合法 UTF-8 且含中文时，内核对短中文文本可能误猜为 GB 系解码
      // （如仅 4~6 个汉字的 delay.h/Eeprom.h，视图显示“鍑芥暟澹版槑”类乱码），
      // 而按 UTF-8 正确解码的文本与视图不一致。据此自动重开纠偏。
      // 纯 ASCII 无此问题（各编码解码一致），直接跳过。
      if (enc === "utf8") {
        const utf8Text = decodeByDetect(uri.fsPath, enc);
        if (utf8Text === null || !/[\u4e00-\u9fff]/.test(utf8Text)) {
          return;
        }
        if (normalizeText(d.getText()) === normalizeText(utf8Text)) {
          return; // 视图与磁盘一致（内核猜对），无需干预
        }
        // 先登记指纹（无论成败），防止重开事件风暴期间反复触发
        autoDone.set(key, fp);
        L(`磁盘为 UTF-8 但视图不匹配（内核疑按 GB 误读），自动重开纠偏：${uri.fsPath}`);
        // 只试 1 轮：失败不循环抢焦点，保留手动按钮兜底
        const ok = await withForcedEncoding("utf8", () =>
          reopenDisplayedCorrectly(uri, utf8Text, 1, false, metaOf("utf8").ids)
        );
        if (ok) {
          await updateContext();
        } else {
          L(`UTF-8 视图纠偏失败（保留手动按钮可用）：${uri.fsPath}`);
        }
      }
      return;
    }
    const text = decodeByDetect(uri.fsPath, enc);
    if (text === null) {
      L(`自动检测解码失败：${uri.fsPath}`);
      return;
    }
    // 先登记（无论成败），防止事件风暴期间反复重试
    autoDone.set(key, fp);
    L(`检测到 GB 编码文件，尝试自动重开：${uri.fsPath} (${enc})`);
    // 自动检测场景只尝试 1 轮：失败不再循环抢焦点，保留手动按钮兜底
    const ok = await withForcedEncoding("gb2312", () =>
      reopenDisplayedCorrectly(uri, text, 1, false, metaOf("gb2312").ids)
    );
    if (ok) {
      await updateContext();
    } else {
      L(`自动重开失败（保留手动按钮可用）：${uri.fsPath}`);
    }
  });
}

// ===== 批量模式：勾选设置后，一次性转换整个文件夹中的 .c/.h =====
// 设计参考：gbk2utf8-vscode（备份/忽略目录）、Smart Encoding Converter（有损跳过）、
// BatchEncoding（dirty 文件拒绝转换）。核心保证“无乱码”：
//   1) 仅处理可可靠判定编码的文件（utf8/utf-8 BOM/gb2312/gbk）
//   2) 解码结果含 U+FFFD 的文件视为已损坏，跳过（防止 rgb.c 式乱码固化二次扩散）
//   3) round-trip 校验：目标编码编码后再解码必须与源文本一致，否则视为有损，跳过
//   4) 有未保存修改（dirty）的文件跳过
//   5) 转换前弹窗确认

// 目标编码统一元数据：显示名 / iconv 编码名 / 重开时内核 files.encoding 强制值 /
// 内核 TextDocument.encoding 可能报告的 id 集合
interface EncMeta {
  label: string;
  iconv: string;
  forced: string;
  ids: string[];
}
const TARGET_META: Record<string, EncMeta> = {
  utf8: {
    label: "UTF-8",
    iconv: "utf-8",
    forced: "utf8",
    ids: ["utf8", "utf-8", "utf8bom"],
  },
  gb2312: {
    label: "GB2312",
    iconv: "gb2312",
    forced: "gb2312",
    ids: ["gb2312", "gbk", "gb18030"],
  },
};
function metaOf(target: string): EncMeta {
  return TARGET_META[target] ?? TARGET_META.utf8;
}

// ===== 转换范围（键1）：此文件 ↔ 整个文件夹全部 =====
// 仅会话内有效，不持久化：每次启动默认“此文件”
let scopeBatch = false;
function setScopeBatch(v: boolean): void {
  scopeBatch = v;
  void vscode.commands.executeCommand(
    "setContext",
    "encoding-switcher:scopeBatch",
    v
  );
  L(`转换范围切换为：${v ? "整个文件夹全部" : "此文件"}`);
}

async function runBatchConvert(target: string): Promise<void> {
  if (convertBusy) {
    vscode.window.showInformationMessage("编码转换正在进行中，请稍候再试");
    return;
  }
  convertBusy = true;
  const exclude = new Set(
    ((vscode.workspace.getConfiguration("encoding-switcher.batch").get<string[]>("exclude")) ?? [
      "output",
      "node_modules",
      ".git",
      ".vscode",
    ]).map((s) => s.toLowerCase())
  );
  const targetLabel = metaOf(target).label;
  try {
    // 目标文件夹 = 当前活动文件所在目录（不含子文件夹、不含工作区根的其余部分）；
    // 没有活动文件时无法确定目标，要求先打开目标文件夹中的任意文件
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      vscode.window.showWarningMessage(
        "批量转换：请先打开目标文件夹中的任意文件（以此确定目标文件夹）"
      );
      return;
    }
    const rootDir = path.dirname(editor.document.uri.fsPath);

    // 1) 扫描 .c/.h —— 仅该文件夹顶层，不递归子文件夹
    let names: string[] = [];
    try {
      names = fs.readdirSync(rootDir);
    } catch {
      vscode.window.showWarningMessage(`批量转换：无法读取文件夹 ${rootDir}`);
      return;
    }
    const all: vscode.Uri[] = [];
    for (const name of names) {
      if (!/\.(c|h)$/i.test(name) || exclude.has(name.toLowerCase())) {
        continue;
      }
      const fp = path.join(rootDir, name);
      try {
        if (!fs.statSync(fp).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      all.push(vscode.Uri.file(fp));
    }
    L(
      `批量转换：扫描 ${rootDir}（仅顶层，不含子文件夹），共 ${all.length} 个 .c/.h 文件`
    );

    // 2) 逐文件检测分类
    const jobs: { uri: vscode.Uri; text: string }[] = [];
    let skippedSame = 0;
    const skippedUnknown: string[] = [];
    const corrupted: string[] = [];
    const lossy: string[] = [];
    const dirty: string[] = [];
    const errors: string[] = [];

    for (const uri of all) {
      try {
        const d = findByUri(uri);
        if (d && d.isDirty) {
          dirty.push(uri.fsPath);
          continue;
        }
        const bytes = fs.readFileSync(uri.fsPath);
        const enc = detectEncoding(bytes);
        if (enc === "unknown") {
          skippedUnknown.push(uri.fsPath);
          continue;
        }
        // 按检测到的源编码解码（decodeFileBytes 会去 UTF-8 BOM）
        const text = decodeByDetect(uri.fsPath, enc);
        if (text === null) {
          skippedUnknown.push(uri.fsPath);
          continue;
        }
        // 损坏防护：解码结果含替换符（rgb.c 式二次损坏），转换无意义，跳过
        if (text.includes("\ufffd")) {
          corrupted.push(uri.fsPath);
          continue;
        }
        const isTarget =
          (target === "utf8" && (enc === "utf8" || enc === "utf-8")) ||
          (target === "gb2312" && enc === "gb2312");
        if (isTarget) {
          skippedSame++;
          continue;
        }
        // round-trip 有损检测（仅降位转换需要：如 UTF-8→GB2312、GBK→GB2312）
        const reEncoded = iconv.encode(text, target);
        const roundTrip = iconv.decode(reEncoded, target);
        if (roundTrip !== text) {
          lossy.push(uri.fsPath);
          continue;
        }
        jobs.push({ uri, text });
      } catch (e) {
        errors.push(`${uri.fsPath}: ${String(e)}`);
      }
    }

    if (jobs.length === 0) {
      vscode.window.showInformationMessage(
        `批量转换：没有可转换的 .c/.h 文件（已是 ${targetLabel}：${skippedSame}，未知编码：${skippedUnknown.length}，损坏：${corrupted.length}，有损风险：${lossy.length}，未保存：${dirty.length}）`
      );
      return;
    }

    // 3) 确认弹窗（显示完整根路径，防止把批量范围搞错文件夹）
    const summary =
      `将仅在 ${rootDir} 中把 ${jobs.length} 个 .c/.h 文件转换为 ${targetLabel}（不含子文件夹）。` +
      `跳过：已是目标 ${skippedSame}、未知编码 ${skippedUnknown.length}、损坏 ${corrupted.length}、有损 ${lossy.length}、未保存 ${dirty.length}。`;
    const pick = await vscode.window.showWarningMessage(
      summary,
      { modal: true },
      "开始转换"
    );
    if (pick !== "开始转换") {
      L(`批量转换：用户取消。${summary}`);
      return;
    }

    // 批量开始即自动复位为“此文件”（范围状态不持久化，防下次误触批量）
    setScopeBatch(false);

    // 4) 执行转换（按源解码文本以目标编码写回 → 登记指纹防重复干预）
    const converted: { uri: vscode.Uri; text: string }[] = [];
    for (const j of jobs) {
      try {
        if (!writeFileWithEncoding(j.uri.fsPath, j.text, target)) {
          errors.push(`${j.uri.fsPath}: 写入失败`);
          continue;
        }
        autoDone.set(j.uri.toString(), diskFingerprint(j.uri));
        converted.push(j);
        L(`批量转换完成：${j.uri.fsPath} → ${targetLabel}`);
      } catch (e) {
        errors.push(`${j.uri.fsPath}: ${String(e)}`);
      }
    }

    // 5) 已打开的文件串行重开刷新视图：整体作为一个队列任务执行，
    //    重开期间临时锁定内核解码编码为目标编码（不依赖猜测，短中文文件也正确）
    let reopened = 0;
    let refreshFailed = 0;
    if (converted.some((j) => findByUri(j.uri))) {
      await enqueueAuto(async () => {
        await withForcedEncoding(target, async () => {
          // 批量统一目标编码 → 内核检查用同一组 id
          const encIds = metaOf(target).ids;
          for (const j of converted) {
            if (!findByUri(j.uri)) {
              continue;
            }
            // 批量场景只试 1 轮，避免多文件循环抢焦点
            const ok = await reopenDisplayedCorrectly(
              j.uri,
              j.text,
              1,
              true,
              encIds
            );
            if (ok) {
              reopened++;
            } else {
              refreshFailed++;
              L(
                `批量重开刷新失败（文件内容已正确保存，仅视图未刷新，请关闭该文件标签后重新打开）：${j.uri.fsPath}`
              );
            }
          }
        });
      });
    }

    // 6) 汇总
    const msg =
      `批量转换完成：成功 ${converted.length}，失败 ${errors.length}。` +
      `跳过：已是 ${targetLabel} ${skippedSame}、未知编码 ${skippedUnknown.length}、损坏 ${corrupted.length}、有损 ${lossy.length}、未保存 ${dirty.length}。` +
      `已打开文件将自动刷新显示。`;
    L(`批量转换汇总：${msg}`);
    if (errors.length > 0) {
      L(`批量转换失败明细：\n${errors.join("\n")}`);
    }
    if (corrupted.length > 0) {
      L(`损坏文件（解码含乱码替换符，请人工检查，勿直接保存覆盖）：\n${corrupted.join("\n")}`);
    }
    if (refreshFailed > 0) {
      const rf =
        `${refreshFailed} 个文件视图未自动刷新（文件内容已正确保存到磁盘，显示乱码是内核缓存所致）。` +
        `请关闭对应文件标签后重新打开即可正常显示。`;
      L(`批量视图刷新：${rf}`);
      showLogMsg(rf, "warn");
    }
    if (lossy.length > 0) {
      L(`有损风险文件（目标编码无法完整表示，未转换）：\n${lossy.join("\n")}`);
    }
    showLogMsg(msg, "info");
    await updateContext();
  } catch (e) {
    L(`批量转换异常：${String(e)}`);
    vscode.window.showErrorMessage(`批量转换异常：${String(e)}`);
  } finally {
    convertBusy = false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("编码切换器");
  context.subscriptions.push(log);
  // 诊断日志镜像：输出面板不落盘时，从临时文件仍可取证
  logFile = path.join(os.tmpdir(), "encoding-switcher-diag.log");
  L("扩展已激活（诊断镜像：" + logFile + "）");

  // ===== 键1 范围切换：此文件 ↔ 整个文件夹全部（仅会话内有效，不持久化） =====
  const toggleScope = () => setScopeBatch(!scopeBatch);

  // ===== 键2 执行转换：按键1选定的范围执行 =====
  const runConvert = (target: string) => {
    if (scopeBatch) {
      void runBatchConvert(target);
    } else {
      void convertTo(target);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("encoding-switcher.scopeFile", toggleScope),
    vscode.commands.registerCommand(
      "encoding-switcher.scopeFolder",
      toggleScope
    ),
    vscode.commands.registerCommand("encoding-switcher.toggleToUtf8", () => {
      runConvert("utf8");
    }),
    vscode.commands.registerCommand("encoding-switcher.toggleToGb2312", () => {
      runConvert("gb2312");
    })
  );

  // 键1 初始状态：此文件（默认）
  setScopeBatch(false);

  // 启用内核“自动猜测编码”（重开时正确解码的前提）
  void ensureAutoGuessEncoding();
  // 工作区回退编码 gb2312：短中文 GB 文件防乱码根治
  void ensureWorkspaceEncoding();
  // 保存拦截：乱码视图禁止写盘
  registerSaveGuard(context);

  // 活动编辑器变化时刷新上下文（决定显示哪个按键）
  // 防抖：切换/打开事件可能密集触发，避免每次都同步读盘
  let ctxTimer: NodeJS.Timeout | undefined;
  const scheduleContextUpdate = () => {
    if (ctxTimer) {
      clearTimeout(ctxTimer);
    }
    ctxTimer = setTimeout(() => updateContext(), 120);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => scheduleContextUpdate())
  );
  // 保存也可能改变磁盘编码（如系统自带“通过编码保存”），需同步刷新按钮
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduleContextUpdate())
  );
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      scheduleContextUpdate();
      if (doc.uri.scheme === "file") {
        scheduleAutoReopen(doc.uri);
      }
    })
  );

  // 覆盖编辑器启动时恢复的已打开标签（不触发 onDidOpenTextDocument）
  setTimeout(() => {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "file") {
        scheduleAutoReopen(doc.uri);
      }
    }
  }, 800);

  // 初次激活时刷新一次
  updateContext();
}

export function deactivate() {}
