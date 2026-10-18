/**
 * 适配器工厂：按 adapterType 构造对应适配器实现。
 * 新增网页 AI 时：实现一个新的 IModelAdapter 子类 + 在此工厂注册一条，
 * Agent Runtime 与工具循环无需任何改动。
 */
import type { BackendConfig } from './IModelAdapter.js';
import type { IModelAdapter } from './IModelAdapter.js';
import { DeepSeekWebAdapter } from './DeepSeekWebAdapter.js';
import { MimoWebAdapter } from './MimoWebAdapter.js';

export type AdapterType = BackendConfig['adapterType'];

export function createAdapter(cfg: BackendConfig): IModelAdapter {
  switch (cfg.adapterType) {
    case 'deepseek-web':
      return new DeepSeekWebAdapter(cfg);
    case 'mimo-web':
      return new MimoWebAdapter(cfg);
    // case 'qianwen-web':   // 第四阶段实现
    //   return new QianwenWebAdapter(cfg);
    default:
      throw new Error(`未知适配器类型：${String(cfg.adapterType)}`);
  }
}
