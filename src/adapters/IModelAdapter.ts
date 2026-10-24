/**
 * 统一模型适配器接口 —— Agent Runtime 只依赖这些类型与抽象类，
 * 不直接依赖任何具体网页（DeepSeek / 千问 / ...）的页面结构。
 */

/** 每个模型后端的静态配置（不含任何凭据；登录态由浏览器 profile 承载） */
export interface BackendConfig {
  /** 唯一 id，例如 "deepseek" */
  id: string;
  /** 显示名称 */
  displayName: string;
  /** 网页地址 */
  startUrl: string;
  /** 适配器类型名，决定运行时加载哪个适配器实现 */
  adapterType: 'deepseek-web' | 'mimo-web' | 'qianwen-web' | 'generic-web';
  enabled?: boolean;
  /** 浏览器会话配置 */
  browser: {
    /** CDP 远程调试端口 */
    debugPort: number;
    /** 浏览器专用 profile 目录（相对项目根），用于承载登录态 */
    profileDir: string;
    /** Edge 可执行文件路径；留空则自动探测 */
    executablePath?: string;
  };
  /** 选择器覆盖（可选）。各适配器有默认值；页面改版时可在此覆盖而无需改代码 */
  selectors?: Record<string, string>;
  capabilities?: BackendCapabilities;
  /** 用途说明/已知限制 */
  notes?: string;
}

/** 运行时探测到的后端能力 */
export interface BackendCapabilities {
  /** 是否支持多轮会话 */
  multiTurnConversation: boolean | null;
  /** 是否支持附件 */
  attachments: boolean | null;
  /** 是否支持流式回复（能否确认） */
  streaming: boolean | null;
}

/** 适配器运行状态（供管理界面/配置展示） */
export interface AdapterStatus {
  connectionState: ConnectionState;
  capabilities: BackendCapabilities;
  lastError: string | null;
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  loggedIn: boolean | null;
}
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'login-required'
  | 'error';

/** 网页端会话状态（区别于本地 Agent 任务状态） */
export interface WebConversationState {
  /** 网页会话标识（通常从 URL 或 DOM 提取；无则 null） */
  conversationId: string | null;
  /** 当前页面 URL */
  url: string;
  /** 最近一次成功发送时间（epoch ms） */
  lastSentAt: number | null;
  /** 最近一次成功收到回复时间（epoch ms） */
  lastReceivedAt: number | null;
  /** 会话中已见到的助手消息条数 */
  assistantMessageCount: number;
}

/** 单条对话记录 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  /** 思考过程（模型侧推理文本；页面提供了才记录，用于跨模型交接） */
  thinking?: string;
}

/** waitForResponse 的可调参数 */
export interface WaitForResponseOptions {
  /** 发送前快照，用于识别"新增的"回复 */
  baselineAssistantCount: number;
  /** 发送前聊天内容区指纹（可选，双通道新回复检测） */
  baselineChatFp?: string;
  /** 本次发送的用户消息文本（用于把差分中的用户消息段落剔除） */
  sentText?: string;
  /** 发送前已完成的网络响应条数（网络通道基线，最可靠的回复通道） */
  netBaseline?: number;
  totalTimeoutMs: number;
  /** 回复文本需要连续稳定 N 次轮询才判定完成 */
  stablePolls: number;
  /** 额外要求答复文本保持稳定的最短毫秒数（防"长思考中的短暂停顿"被误判为完成；0/省略=不要求） */
  minStableMs?: number;
  pollIntervalMs: number;
  /** 命中这些关键词时按“被网页拒绝/受限”处理（适配器可自行补充） */
  rejectPatterns?: string[];
}

/** 适配器统一结果包装：显式区分成功与可分类失败，供 Runtime 决策 */
export type AdapterResultCode =
  | 'not-connected'
  | 'login-required'
  | 'dom-not-found'
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'truncated-suspected'
  | 'page-structure-changed'
  | 'rejected-by-site'
  | 'internal-error';

export type AdapterResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: AdapterResultCode;
      message: string;
      /** true = 调用方可以安全重试（传输类失败）；false = 需要人工介入或换路 */
      retryable: boolean;
    };

/**
 * 统一模型适配器抽象类。
 */
export abstract class IModelAdapter {
  abstract get backendId(): string;

  /** 连接选定的模型后端（附加到浏览器实例并就位页面） */
  abstract connect(): Promise<AdapterResult<void>>;

  /** 发送一条用户消息（不等待回复） */
  abstract sendMessage(text: string): Promise<AdapterResult<void>>;

  /** 获取完整回复（以页面文本稳定为准；thinking=思考过程文本，页面提供时才非空） */
  abstract waitForResponse(
    opts: WaitForResponseOptions,
  ): Promise<AdapterResult<{ text: string; complete: boolean; thinking?: string }>>;

  /** 获取网页端会话状态 */
  abstract getConversationState(): Promise<WebConversationState>;

  /** 当前连接状态与最近一次失败原因（供管理界面/配置显示） */
  abstract getStatus(): AdapterStatus;

  /** 新建会话 */
  abstract startNewConversation(): Promise<AdapterResult<void>>;

  /** 尝试恢复会话（浏览器重启/页面刷新/会话丢失后调用） */
  abstract recoverConversation(
    state: WebConversationState,
  ): Promise<AdapterResult<WebConversationState>>;

  /** 断开连接 */
  abstract disconnect(): Promise<void>;

  /** 聊天内容区指纹（可选能力；默认空字符串） */
  async captureChatFingerprint(): Promise<string> {
    return '';
  }

  /** 已捕获的网络响应条数（可选能力；默认 0，表示无网络通道） */
  async captureNetBaseline(): Promise<number> {
    return 0;
  }

  /** 发送前的助手消息计数快照（可选能力；默认 0 —— DOM 回退通道仅用于识别"新增"回复） */
  async snapshotBaseline(): Promise<number> {
    return 0;
  }

  /** 切换深度思考（若该网页有此开关）。默认：不支持（返回 false，跳动无副作用）。
   *  实现方：点击页面开关并返回是否提交成功。状态由各自适配器尽力自检。 */
  async setDeepThink(_enabled: boolean): Promise<boolean> {
    return false;
  }
}

/** 简易 runtime 日志（后续阶段替换为结构化日志） */
export interface RuntimeLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
