// 编码检测工具模块
// 设计思路：
// 1. 先判断是否为 UTF-8 BOM（EF BB BF），命中返回 "utf-8"。
// 2. 否则判是否为合法 UTF-8（无 BOM），命中返回 "utf8"（VSCode 中 = UTF-8 无 BOM）。
//    注意：VSCode 编码标签里 "utf-8" 带 BOM，"utf8" 不带 BOM，二者不可混用。
// 3. 若不是 UTF-8，则按 GBK 解码尝试，并进一步区分 GB2312（GBK 的子集）。
// 4. 返回检测到的编码标签，供重新打开或转换使用。

import * as iconv from "iconv-lite";

// 与 VSCode 编码标签对齐：
//  "utf-8"  = UTF-8 with BOM
//  "utf8"    = UTF-8 without BOM
//  "gbk"     = GBK
//  "gb2312"  = GB2312
export type DetectedEncoding =
  | "utf-8"
  | "utf8"
  | "gbk"
  | "gb2312"
  | "unknown";

// 判断字节序列是否为合法 UTF-8（不含 BOM 判定，调用方已处理 BOM）
export function isUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  const n = bytes.length;

  // 不含 BOM 跳过逻辑

  while (i < n) {
    const b0 = bytes[i];
    let extra = 0;
    let min = 0;
    if (b0 < 0x80) {
      i += 1;
      continue;
    } else if ((b0 & 0xe0) === 0xc0) {
      extra = 1;
      min = 0x80;
    } else if ((b0 & 0xf0) === 0xe0) {
      extra = 2;
      min = 0x800;
    } else if ((b0 & 0xf8) === 0xf0) {
      extra = 3;
      min = 0x10000;
    } else {
      return false; // 非法首字节
    }

    if (i + extra >= n) {
      return false;
    }

    let cp = b0 & (0xff >> (extra + 1));
    for (let k = 1; k <= extra; k++) {
      const bk = bytes[i + k];
      if ((bk & 0xc0) !== 0x80) {
        return false;
      }
      cp = (cp << 6) | (bk & 0x3f);
    }

    if (cp < min) {
      return false; // 过度编码
    }
    // 代理区非法
    if (cp >= 0xd800 && cp <= 0xdfff) {
      return false;
    }
    i += extra + 1;
  }
  return true;
}

// 用 iconv-lite 做权威解码（gbk 与 gb2312 标签）
// iconv-lite 遇无法解码字节会输出替换字符 U+FFFD（不抛错），需自行判定为非法
function decodeWith(encoding: string, bytes: Uint8Array): string | null {
  try {
    const text = iconv.decode(Buffer.from(bytes), encoding);
    if (text.includes("\ufffd")) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

// 主检测入口
export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (bytes.length === 0) {
    return "utf8";
  }

  // 1. UTF-8 BOM 直接判定（带 BOM）
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return "utf-8";
  }

  // 2. 合法 UTF-8（无 BOM）
  if (isUtf8(bytes)) {
    return "utf8";
  }

  // 3. 尝试 GBK / GB2312 解码
  const gbkText = decodeWith("gbk", bytes);
  if (gbkText !== null) {
    // 进一步判断是否为 GB2312（GB2312 是 GBK 的子集）
    const gb2312Text = decodeWith("gb2312", bytes);
    if (gb2312Text !== null) {
      return "gb2312";
    }
    return "gbk";
  }

  return "unknown";
}
