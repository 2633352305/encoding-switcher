import * as vscode from "vscode";
import * as fs from "fs";
import * as iconv from "iconv-lite";
import { detectEncoding } from "./encoding";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 诊断日志（输出面板 → “编码切换器”）
let log: vscode.OutputChannel;
function L(msg: string): void {
  try {
    log?.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  } catch {
    // 忽略
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

// ===== 核心：关闭→重开，并用“实际显示内容”验证 =====
//
// 验证不依赖 doc.encoding 属性，而是轮询读取 doc.getText() 与
// “按正确编码解码出的文本”比对 —— 内容匹配即说明视图已正确。
// 依赖内核 autoGuessEncoding 在重开时猜中 GB2312/UTF-8。
async function reopenDisplayedCorrectly(
  uri: vscode.Uri,
  expectedText: string
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

  // 轮询等待：重开是异步的，需等新模型就绪；内容与预期一致才算成功
  const displayedOK = async (maxPolls: number): Promise<boolean> => {
    for (let i = 0; i < maxPolls; i++) {
      await sleep(120);
      const d = findByUri(uri);
      if (!d || d.isDirty) {
        continue;
      }
      if (normalizeText(d.getText()) === expect) {
        return true;
      }
    }
    return false;
  };

  // 已经正确显示（打开时已被内核猜对）。
  // 多轮询几次：文档刚打开可能尚未加载完，立即判定会误判并触发无谓的重开刷新
  if (await displayedOK(6)) {
    L(`显示已正确：${uri.fsPath}`);
    return true;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    // 关闭该 uri 的所有编辑器，释放旧解码缓存的文档模型
    let closed = 0;
    for (const d of [...vscode.workspace.textDocuments]) {
      if (d.uri.toString() !== uri.toString()) {
        continue;
      }
      try {
        await vscode.window.showTextDocument(d, { preview: false });
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        closed++;
      } catch {
        // 忽略
      }
      await sleep(60);
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
    if (reopened && (await displayedOK(10))) {
      L(`第${attempt}次关闭重开后显示正确：${uri.fsPath}`);
      return true;
    }
    L(`第${attempt}次关闭重开后仍未正确显示：${uri.fsPath}`);
  }

  L(`全部重开策略失败：${uri.fsPath}`);
  return false;
}

// 将当前文件从源编码转为目标编码并保存（按源编码正确解码，避免中文乱码）
async function convertTo(targetEnc: string, targetLabel: string): Promise<void> {
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
  let text: string | null;
  if (srcEnc === "utf8" || srcEnc === "utf-8") {
    text = decodeFileBytes(filePath, "utf-8");
  } else if (srcEnc === "gb2312") {
    text = decodeFileBytes(filePath, "gb2312");
  } else if (srcEnc === "gbk") {
    text = decodeFileBytes(filePath, "gbk");
  } else {
    vscode.window.showWarningMessage(
      "无法判断当前文件编码（非 GB2312 / UTF-8），未做转换"
    );
    return;
  }
  if (text === null) {
    vscode.window.showErrorMessage(`读取源文件失败（编码：${srcEnc}）`);
    return;
  }

  // 3) 以目标编码写回（UTF-8 不写 BOM）
  if (!writeFileWithEncoding(filePath, text, targetEnc)) {
    vscode.window.showErrorMessage(`切换为 ${targetLabel} 失败`);
    return;
  }

  // 转换成功后记录新指纹，避免自动检测重复干预
  autoDone.set(doc.uri.toString(), diskFingerprint(doc.uri));

  // 等待文件监听处理完外部写入，再关闭重开触发重新解码
  await sleep(400);

  // 4) 关闭重开并验证显示内容
  L(`转换完成：${filePath} ${srcEnc} → ${targetEnc}，开始重开验证`);
  let ok = false;
  try {
    ok = await reopenDisplayedCorrectly(doc.uri, text);
  } catch (e) {
    L(`重开过程异常: ${String(e)}`);
    ok = false;
  }
  if (!ok) {
    vscode.window
      .showErrorMessage(
        `已转换为 ${targetLabel} 并保存到磁盘，但视图未能自动刷新为新编码。请手动关闭该文件后重新打开。可到输出面板「编码切换器」查看诊断日志。`,
        "打开日志"
      )
      .then((choice) => {
        if (choice === "打开日志") {
          log.show();
        }
      });
    return;
  }

  // 5) 刷新按键显示（文件编码已改变）
  await updateContext();
  vscode.window.showInformationMessage(`已切换为 ${targetLabel} 并保存`);
}

// 根据当前活动编辑器文件编码，更新上下文变量控制显示哪个按键
async function updateContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let isGb2312 = false;
  let isUtf8 = false;
  if (
    editor &&
    !editor.document.isUntitled &&
    editor.document.uri.scheme === "file"
  ) {
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
  await vscode.commands.executeCommand(
    "setContext",
    "encoding-switcher:isGb2312",
    isGb2312
  );
  await vscode.commands.executeCommand(
    "setContext",
    "encoding-switcher:isUtf8",
    isUtf8
  );
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

// 串行队列：多个文件的自动重开逐个执行，避免互相干扰（激活编辑器抢焦点）
let autoChain: Promise<void> = Promise.resolve();
function enqueueAuto(task: () => Promise<void>): void {
  autoChain = autoChain.then(task).catch(() => {});
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
      return;
    }
    const decodeName = enc === "gbk" ? "gbk" : "gb2312";
    const text = decodeFileBytes(uri.fsPath, decodeName);
    if (text === null) {
      L(`自动检测解码失败：${uri.fsPath}`);
      return;
    }
    // 先登记（无论成败），防止事件风暴期间反复重试
    autoDone.set(key, fp);
    L(`检测到 GB 编码文件，尝试自动重开：${uri.fsPath} (${enc})`);
    const ok = await reopenDisplayedCorrectly(uri, text);
    if (ok) {
      await updateContext();
    } else {
      L(`自动重开失败（保留手动按钮可用）：${uri.fsPath}`);
    }
  });
}

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("编码切换器");
  context.subscriptions.push(log);

  context.subscriptions.push(
    vscode.commands.registerCommand("encoding-switcher.toggleToUtf8", () => {
      void convertTo("utf8", "UTF-8");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("encoding-switcher.toggleToGb2312", () => {
      void convertTo("gb2312", "GB2312");
    })
  );

  // 启用内核“自动猜测编码”（重开时正确解码的前提）
  void ensureAutoGuessEncoding();

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
  L("扩展已激活");
}

export function deactivate() {}
