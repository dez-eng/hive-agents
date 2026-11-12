/**
 * 全局常量与环境。跑起来才开始读环境变量，import 本模块不会产生副作用。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bandNow, type Band } from './cost.js';

export const APP_NAME = 'hive';
export const VERSION = '0.1.0';

/** 包根目录（src/core 或 dist/core 向上两级）—— 全局安装时也能找到自带的 .env */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 缓存块大小。6.7 实测：DeepSeek 的命中量永远整除 64，
 * 未命中 = (入 mod 64) + 64k，内容动不了它。
 */
export const BLOCK = 64;

export function modelName(): string {
  return (process.env.DEEPSEEK_MODEL ?? '').trim() || 'deepseek-flash';
}

/**
 * v4 M4.2：DeepSeek 兼容端点。
 * 不设 = 走官方；自建代理 / 本地兼容服务才需要（如 http://127.0.0.1:11434/v1）。
 */
export function baseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL ?? '').trim();
}

/** 0 = 不封顶。实测封顶只会把答案切断，省不了钱 */
export function maxOut(): number {
  const n = Number.parseInt(process.env.HIVE_MAX_OUT ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 一轮（一次 `run()`）的**预算闸门**：token，0 = 不封顶。
 * 2026-10-16 拍板默认 20000 —— 真机正常轮是 2k~3k token（C 1548 / D 2417~3121），
 * 留 2~6 倍余量，只在明显不对劲时熔断。
 *
 * ⚠ 与 `maxOut()` 不是一回事：那个截断**输出**，这个熔断**整轮**。
 */
/** 拍板的默认值（2026-10-16）—— 也用于「配置写坏时退回哪」 */
export const DEFAULT_TURN_BUDGET = 20_000;
export const DEFAULT_TOOL_STEPS = 16;
export const DEFAULT_COMPRESS_AT = 24_000;
export const DEFAULT_COMPRESS_KEEP = 16;

/**
 * 读一个非负整数 env。返回 `null` = 没设或写坏了 —— 由调用方决定退回什么。
 * ⚠ 这一步必须与 `0` 区分开：`0` 是使用者显式说的"不封顶/不限"，
 * 而"写坏了"应当**退回保守默认**，不能因为手滑就把闸门关掉。
 */
function readCount(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = (env[key] ?? '').trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function turnBudget(): number {
  const n = readCount(process.env, 'HIVE_TURN_BUDGET');
  if (n === null) return DEFAULT_TURN_BUDGET;
  return n > 0 ? n : 0;
}

/** 一次 `run()` 内工具批次上限。0 = 不限（默认 16） */
export function toolSteps(): number {
  const n = readCount(process.env, 'HIVE_TOOL_STEPS');
  if (n === null) return DEFAULT_TOOL_STEPS;
  return n > 0 ? n : 0;
}

/**
 * 上一轮入 token 超过它就压一次历史；0 = 从不压。
 * 用它当尺子是刻意的：这是**真实计量**，免费且准确，不用另做估算。
 */
export function compressAt(): number {
  const n = readCount(process.env, 'HIVE_COMPRESS_AT');
  if (n === null) return DEFAULT_COMPRESS_AT;
  return n > 0 ? n : 0;
}

/** 压缩后保留最近多少条消息（太小的值等于没压，直接退回默认） */
export function compressKeep(): number {
  const n = readCount(process.env, 'HIVE_COMPRESS_KEEP');
  if (n === null || n < 4) return DEFAULT_COMPRESS_KEEP;
  return n;
}

/**
 * 账本默认写在工作目录的 costs.db —— 与阶段 6.7 的 Python 版同名同表，
 * 于是本工具开箱就能读到你之前那批历史账（只会自动补一列 module）。
 * 想跟旧的隔开就设 HIVE_LEDGER=.hive/costs.db
 */
export function ledgerPath(): string {
  return (process.env.HIVE_LEDGER ?? '').trim() || 'costs.db';
}

export function memoryPath(): string {
  return (process.env.HIVE_MEMORY ?? '').trim() || '.hive/memory.db';
}

export function currentBand(at?: Date): Band {
  return bandNow(at);
}

/**
 * 启动时尝试的 `.env`，按优先级从低到高：
 *   包根（全局装一次 key 到处可用） → `~/.hive/.env`（用户级） → 当前目录（项目级最高）
 *
 * shell 里已经 export 的变量仍然最优先，任何文件都盖不掉。
 */
export function envFiles(cwd = process.cwd()): string[] {
  const home = (process.env.USERPROFILE || process.env.HOME || '').trim();
  const list = [resolve(PACKAGE_ROOT, '.env')];
  if (home) list.push(resolve(home, '.hive', '.env'));
  list.push(resolve(cwd, '.env'));
  return [...new Set(list)];
}

/**
 * 读 .env（Node 20.12+ 内置，不需要 dotenv 依赖）。没有文件就安静跳过。
 *
 * 默认读 `envFiles()` 的三处 —— 这样从任意目录运行全局 `hive` 也能拿到 key，
 * 而不必把整个项目复制到当前目录。
 */
export function loadDotEnv(files: string | string[] = envFiles()): void {
  const list = Array.isArray(files) ? files : [files];
  const initial = { ...process.env };
  // 高优先级先加载：process.loadEnvFile 不覆盖已存在的变量，所以 cwd 会赢过
  // 用户级与包根，shell 里的值又赢过所有文件。
  for (const f of [...list].reverse()) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* 没有 .env 是正常状态 */
    }
  }
  // 双保险：shell 显式设置的值优先于文件
  for (const [k, v] of Object.entries(initial)) {
    if (v !== undefined) process.env[k] = v;
  }
}

export function hasApiKey(): boolean {
  return Boolean((process.env.DEEPSEEK_API_KEY ?? '').trim());
}
