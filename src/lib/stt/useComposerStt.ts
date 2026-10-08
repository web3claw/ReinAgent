/**
 * 输入框语音识别编排 Hook（移植自 LiveAgent agent-ui/src/pages/chat/useComposerStt.ts）。
 *
 * 与 LiveAgent 的差异：
 * - composerRef 换成本方 textarea 句柄接口 SttComposerHandle；
 * - transport.open 随参传供应商配置（getConfig 取最新设置）。
 */
import {
  appendTailSilence,
  type PcmChunk,
  pcm16ToLittleEndianBytes,
  STT_CONNECT_TIMEOUT_MS,
  STT_SAMPLES_PER_CHUNK,
  STT_SEND_QUEUE_TIMEOUT_MS,
  SttAudioCapture,
  SttPcmFifo,
} from "./audio";
import type { SttProviderSettings, SttProviderId } from "./settings";
import { runtimeConfig } from "./settings";
import type { SttRuntimeEvent, SttTransport, SttUiState } from "./types";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * push-to-talk（长按说话）句柄：由可见的输入框注册给上层，供窗口级按键监听转发。
 * `available` 为 false 时（未选供应商等）上层直接忽略按键。
 */
export interface SttPushToTalkHandle {
  available: boolean;
  pressStart(): void;
  pressEnd(): void;
}

/** 输入框临时文本协议（textarea 版实现见 LexicalComposer）。 */
export interface SttComposerHandle {
  /** 锁定临时文本插入点；false = 当前无法锁定（不启动识别）。 */
  beginTransientText(): boolean;
  updateTransientText(text: string): void;
  commitTransientText(text: string): void;
  /** preserveLastText=true 保留已显示的转写（失败兜底），false 还原快照。 */
  cancelTransientText(options?: { preserveLastText?: boolean }): void;
}

type ActiveSttSession = {
  id: string;
  capture: SttAudioCapture;
  fifo: SttPcmFifo;
  ready: boolean;
  stopping: boolean;
  tailQueued: boolean;
  finishSent: boolean;
  lastText: string;
  sequence: number;
  queue: Promise<void>;
  connectTimer: number;
  finalTimer: number | null;
};

export function useComposerStt(options: {
  composerRef: RefObject<SttComposerHandle | null>;
  provider: SttProviderId | null;
  providerConfigured?: boolean;
  /** 取当前选中供应商的最新配置（识别启动时读取，避免闭包陈旧）。 */
  getProviderSettings: () => SttProviderSettings | null;
  transport?: SttTransport;
  disabled: boolean;
  /** 当前会话或视图身份；变化时取消进行中的识别，避免写进已切换的输入框。 */
  sessionKey?: string;
  /** 输入区被挂起时取消识别，避免用户无法点停止。 */
  hidden?: boolean;
  onError?: (message: string) => void;
  onConfigurationRequired?: () => void;
}) {
  const {
    composerRef,
    provider,
    providerConfigured,
    getProviderSettings,
    transport,
    disabled,
    sessionKey,
    hidden = false,
    onError,
    onConfigurationRequired,
  } = options;
  const [state, setState] = useState<SttUiState>("idle");
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<ActiveSttSession | null>(null);
  /** push-to-talk（长按右 Ctrl）当前是否被按住；松手只停「本次按住」开的会话。 */
  const pttHeldRef = useRef(false);
  /** 松手发生在 start() 尚未开麦完成之前——开麦后立即补停，避免麦克风残留。 */
  const pttPendingStopRef = useRef(false);

  const cleanup = useCallback(
    (preserveLastText: boolean) => {
      const active = activeRef.current;
      activeRef.current = null;
      // 会话结束（含最终结果/失败/中止）即释放按住态，否则下一次按住会被误判为「已按住」而忽略。
      pttHeldRef.current = false;
      if (active) {
        window.clearTimeout(active.connectTimer);
        if (active.finalTimer !== null) window.clearTimeout(active.finalTimer);
        void active.capture.stop();
        active.fifo.clear();
      }
      composerRef.current?.cancelTransientText({ preserveLastText });
    },
    [composerRef],
  );

  const fail = useCallback(
    (message: string, expectedSessionId?: string) => {
      const active = activeRef.current;
      if (expectedSessionId && active?.id !== expectedSessionId) return;
      if (active) void transport?.cancel(active.id).catch(() => undefined);
      const preserve = Boolean(active?.lastText.trim());
      cleanup(preserve);
      setError(message);
      setState("error");
      onError?.(message);
    },
    [cleanup, onError, transport],
  );

  const sendChunk = useCallback(
    (sequence: number, pcm: Int16Array) => {
      const active = activeRef.current;
      if (!active || !transport) return;
      const sessionId = active.id;
      active.queue = active.queue
        .then(() => transport.sendAudio(sessionId, sequence, pcm16ToLittleEndianBytes(pcm)))
        .catch((cause) => {
          fail(errorMessageWithFallback(cause, "发送语音数据失败"), sessionId);
        });
    },
    [fail, transport],
  );

  const queueChunk = useCallback(
    (chunk: PcmChunk) => {
      const active = activeRef.current;
      if (!active) return;
      active.sequence = Math.max(active.sequence, chunk.sequence + 1);
      if (active.ready) {
        sendChunk(chunk.sequence, chunk.pcm);
      } else if (!active.fifo.push(chunk)) {
        fail("云连接超时，语音缓存已达到 10 秒上限");
      }
    },
    [fail, sendChunk],
  );

  const finishProvider = useCallback(
    async (active: ActiveSttSession) => {
      if (
        activeRef.current !== active ||
        !active.ready ||
        !active.stopping ||
        !active.tailQueued ||
        active.finishSent ||
        !transport
      ) {
        return;
      }
      active.finishSent = true;
      let queueTimer = 0;
      try {
        await Promise.race([
          active.queue,
          new Promise<never>((_, reject) => {
            queueTimer = window.setTimeout(() => reject(new Error("发送语音数据超时")), STT_SEND_QUEUE_TIMEOUT_MS);
          }),
        ]);
      } catch (cause) {
        fail(errorMessageWithFallback(cause, "发送语音数据超时"), active.id);
        return;
      } finally {
        window.clearTimeout(queueTimer);
      }
      if (activeRef.current !== active) return;
      try {
        await transport.stop(active.id);
        active.finalTimer = window.setTimeout(() => fail("识别结束超时，已保留最后转写内容"), 5_000);
      } catch (cause) {
        fail(errorMessageWithFallback(cause, "停止识别失败"));
      }
    },
    [fail, transport],
  );

  const abortActiveSession = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    void transport?.cancel(active.id).catch(() => undefined);
    cleanup(Boolean(active.lastText.trim()));
    setState("idle");
  }, [cleanup, transport]);

  const stop = useCallback(async () => {
    const active = activeRef.current;
    if (!active || !transport) return;
    if (active.stopping) {
      abortActiveSession();
      return;
    }
    active.stopping = true;
    setState("stopping");

    // stop() 先 flush 最后一段真实音频，再排固定静音尾帧
    try {
      await active.capture.stop();
    } catch (cause) {
      fail(errorMessageWithFallback(cause, "停止麦克风失败"));
      return;
    }
    const tail = appendTailSilence();
    for (let offset = 0; offset < tail.length; offset += STT_SAMPLES_PER_CHUNK) {
      const pcm = tail.slice(offset, offset + STT_SAMPLES_PER_CHUNK);
      queueChunk({ sequence: active.sequence++, pcm, durationMs: (pcm.length * 1000) / 16_000 });
    }
    if (activeRef.current === active && active.ready) {
      active.tailQueued = true;
      await finishProvider(active);
    } else if (activeRef.current === active) {
      active.tailQueued = true;
    }
  }, [abortActiveSession, fail, finishProvider, queueChunk, transport]);

  const onEvent = useCallback(
    (event: SttRuntimeEvent) => {
      const active = activeRef.current;
      if (!active || event.sessionId !== active.id) return;
      if (event.type === "ready") {
        window.clearTimeout(active.connectTimer);
        active.ready = true;
        // 静音计时从识别就绪起算（不是开麦/连云时刻），否则慢握手会立刻自动停。
        active.capture.resetSilenceClock();
        if (!active.stopping) setState("recognizing");
        for (const chunk of active.fifo.drain()) sendChunk(chunk.sequence, chunk.pcm);
        if (active.stopping && active.tailQueued) void finishProvider(active);
      } else if (event.type === "partial") {
        active.lastText = event.text;
        composerRef.current?.updateTransientText(event.text);
      } else if (event.type === "final") {
        active.lastText = event.text;
        composerRef.current?.commitTransientText(event.text);
        cleanup(true);
        setState("idle");
      } else if (event.type === "error") {
        fail(event.message || "语音识别失败");
      } else if (event.type === "closed") {
        if (!active.stopping) {
          fail("语音识别连接意外关闭");
        } else {
          cleanup(Boolean(active.lastText.trim()));
          setState("idle");
        }
      }
    },
    [cleanup, composerRef, fail, finishProvider, sendChunk],
  );

  const start = useCallback(async (opts?: { fromPtt?: boolean }) => {
    if (!transport || !provider || disabled || activeRef.current) return;
    // 新会话启动即清掉上一轮的「松手」信号（可能来自一次未成功开麦的按住）。
    pttPendingStopRef.current = false;
    if (opts?.fromPtt) {
      if (pttHeldRef.current) return; // 按住期间的键盘自动重复，忽略
      pttHeldRef.current = true;
    }
    // push-to-talk 的可用性由注册方（available）判定；配置不完整/无法锁定输入位时
    // 静默放弃（不弹 toast、不跳设置）——长按操作不该把用户拽去设置页。
    const abandonQuietly = (message: string) => {
      if (opts?.fromPtt) {
        // 复位为 idle：此前可能已置 requesting-permission，否则 active 会永远为真。
        pttHeldRef.current = false;
        setState("idle");
        return;
      }
      setError(message);
      setState("error");
      onError?.(message);
    };
    if (providerConfigured === false) {
      if (opts?.fromPtt) {
        abandonQuietly("STT供应商配置不完整");
        return;
      }
      const message = "STT供应商配置不完整";
      setError(message);
      setState("error");
      if (onConfigurationRequired) onConfigurationRequired();
      else onError?.(message);
      return;
    }
    const providerSettings = getProviderSettings();
    if (!providerSettings) {
      abandonQuietly("STT供应商配置不存在");
      return;
    }
    setError(null);
    setState("requesting-permission");
    if (!composerRef.current?.beginTransientText()) {
      abandonQuietly("无法锁定当前输入位置");
      return;
    }

    try {
      await transport.requestPermission?.();
      const fifo = new SttPcmFifo();
      const capture = new SttAudioCapture({
        onChunk: (chunk) => queueChunk(chunk),
        onSilenceTimeout: () => {
          const current = activeRef.current;
          if (!current?.ready || current.stopping) return;
          void stop();
        },
        onCaptureError: (message) => fail(message),
      });
      const active: ActiveSttSession = {
        id: crypto.randomUUID(),
        capture,
        fifo,
        ready: false,
        stopping: false,
        tailQueued: false,
        finishSent: false,
        lastText: "",
        sequence: 0,
        queue: Promise.resolve(),
        connectTimer: 0,
        finalTimer: null,
      };
      activeRef.current = active;

      // 先开麦缓冲，再开云会话——第一个音节不丢。
      await capture.start();
      if (activeRef.current !== active) {
        await capture.stop();
        return;
      }
      // 按住时开麦需授权/耗时，若用户已松手：立刻停，别把麦克风留着继续录。
      if (pttPendingStopRef.current) {
        pttPendingStopRef.current = false;
        void stop();
        return;
      }
      setState("buffering");
      active.connectTimer = window.setTimeout(() => fail("云端连接超时"), STT_CONNECT_TIMEOUT_MS);
      await transport.open({
        sessionId: active.id,
        provider,
        config: runtimeConfig(providerSettings),
        onEvent,
      });
    } catch (cause) {
      fail(errorMessageWithFallback(cause, "无法启动语音识别"));
    }
  }, [
    composerRef,
    disabled,
    fail,
    getProviderSettings,
    onError,
    onConfigurationRequired,
    onEvent,
    provider,
    providerConfigured,
    queueChunk,
    stop,
    transport,
  ]);

  const toggle = useCallback(() => (activeRef.current ? void stop() : void start()), [start, stop]);

  /** push-to-talk 按下：只在空闲时开新会话（识别中再按不重开）。 */
  const pressStart = useCallback(() => {
    if (activeRef.current) return;
    void start({ fromPtt: true });
  }, [start]);

  /** push-to-talk 松开：只停「本次按住」开的会话，不干扰麦克风按钮开的会话。 */
  const pressEnd = useCallback(() => {
    if (!pttHeldRef.current) return;
    if (!activeRef.current) {
      // 开麦还没完成就松手：标记待停，开麦成功后立即补停。
      pttPendingStopRef.current = true;
      pttHeldRef.current = false;
      return;
    }
    pttHeldRef.current = false;
    void stop();
  }, [stop]);

  const sessionKeyRef = useRef(sessionKey);
  useLayoutEffect(() => {
    if (sessionKeyRef.current === sessionKey) return;
    sessionKeyRef.current = sessionKey;
    abortActiveSession();
  }, [abortActiveSession, sessionKey]);

  useLayoutEffect(() => {
    if (hidden) abortActiveSession();
  }, [abortActiveSession, hidden]);

  useEffect(
    () => () => {
      const active = activeRef.current;
      if (active) void transport?.cancel(active.id).catch(() => undefined);
      cleanup(Boolean(active?.lastText.trim()));
      transport?.dispose?.();
    },
    [cleanup, transport],
  );

  useEffect(() => {
    if ((disabled || !provider) && activeRef.current) void stop();
  }, [disabled, provider, stop]);

  return {
    state,
    error,
    toggle,
    /** push-to-talk（长按说话）：按下 start、松开 stop，与麦克风按钮共用同一会话链路。 */
    pressStart,
    pressEnd,
    active: state !== "idle" && state !== "error",
    available: Boolean(provider && transport),
  };
}

function errorMessageWithFallback(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
