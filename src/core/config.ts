/**
 * 全局常量与环境。跑起来才开始读环境变量，import 本模块不会产生副作用。
 */
import { bandNow, type Band } from './cost.js';

export const APP_NAME = 'hive';
export const VERSION = '0.1.0';

/**
 * 缓存块大小。6.7 实测：DeepSeek 的命中量永远整除 64，
 * 未命中 = (入 mod 64) + 64k，内容动不了它。
 */
export const BLOCK = 64;

export function modelName(): string {
  return (process.env.DEEPSEEK_MODEL ?? '').trim() || 'deepseek-flash';
}

/** 0 = 不封顶。实测封顶只会把答案切断，省不了钱 */
export function maxOut(): number {
  const n = Number.parseInt(process.env.HIVE_MAX_OUT ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
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

/** 读 .env（Node 20.12+ 内置，不需要 dotenv 依赖）。没有文件就安静跳过。 */
export function loadDotEnv(file = '.env'): void {
  try {
    process.loadEnvFile(file);
  } catch {
    /* 没有 .env 是正常状态 */
  }
}

export function hasApiKey(): boolean {
  return Boolean((process.env.DEEPSEEK_API_KEY ?? '').trim());
}
