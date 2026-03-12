/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu thread binding state and target resolution helpers.
 *
 * The upstream OpenClaw `SessionBindingAdapter` surface is not yet exposed to
 * this plugin package, so the plugin keeps a local store with the same core
 * concepts:
 * - conversationId: `<chatId>:topic:<threadId>`
 * - targetSessionKey: the bound ACP/session key
 * - anchorMessageId: a stable message inside the thread used for outbound
 *   `reply_in_thread` delivery when there is no fresh inbound message to reply to
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { LarkClient } from '../core/lark-client';
import { larkLogger } from '../core/lark-logger';
import { getMessageFeishu } from '../messaging/shared/message-lookup';
import { createAccountScopedConfig } from '../core/accounts';

const log = larkLogger('channel/thread-bindings');

export type FeishuBindingTargetKind = 'session' | 'subagent';
export type FeishuBindingStatus = 'active' | 'ending' | 'ended';

export interface FeishuThreadBindingRecord {
  bindingId: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  targetKind: FeishuBindingTargetKind;
  status: FeishuBindingStatus;
  boundAt: number;
  lastTouchedAt: number;
  metadata: Record<string, unknown>;
}

export interface FeishuBindingInboundContext {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  effectiveThreadId?: string;
}

export interface FeishuBootstrapBindingResult {
  binding: FeishuThreadBindingRecord;
  threadId: string;
  anchorMessageId: string;
}

interface ParsedFeishuConversationTarget {
  rawTarget: string;
  target: string;
  chatId: string;
  threadId?: string;
  conversationId?: string;
}

interface StoredBindingMetadata {
  anchorMessageId?: string;
  threadId?: string;
  parentChatId?: string;
  createdFromMessageId?: string;
}

interface FeishuResolvedSendTarget {
  target: string;
  replyToMessageId?: string;
  replyInThread: boolean;
  threadId?: string;
  conversationId?: string;
}

const TOPIC_SEPARATOR = ':topic:';
const DEFAULT_INTRO_TEXT = '已创建 ACP 话题，会话后续消息将继续发送到这里。';

/** 账号内 conversationId -> binding 的索引。 */
const bindingsByAccountConversation = new Map<string, FeishuThreadBindingRecord>();
/** 账号内 sessionKey -> bindings 的索引，便于后续会话维度检索。 */
const bindingsByAccountSession = new Map<string, Set<string>>();
/** 当前入站消息上下文，供后续 child placement bootstrap 使用。 */
const inboundContextStorage = new AsyncLocalStorage<FeishuBindingInboundContext>();

function resolveConversationKey(accountId: string, conversationId: string): string {
  return `${accountId.trim().toLowerCase()}:${conversationId.trim()}`;
}

function resolveSessionKeyIndex(accountId: string, sessionKey: string): string {
  return `${accountId.trim().toLowerCase()}:${sessionKey.trim()}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toStoredBindingMetadata(metadata: Record<string, unknown> | undefined): StoredBindingMetadata {
  return {
    anchorMessageId: normalizeOptionalString(metadata?.anchorMessageId),
    threadId: normalizeOptionalString(metadata?.threadId),
    parentChatId: normalizeOptionalString(metadata?.parentChatId),
    createdFromMessageId: normalizeOptionalString(metadata?.createdFromMessageId),
  };
}

/**
 * 从标准 agent session key 中提取 agentId。
 *
 * 这里不依赖上游内部工具，避免引入当前插件包尚未暴露的 SDK surface。
 */
export function resolveAgentIdFromSessionKeyLocal(sessionKey: string | undefined): string {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return 'main';
  }
  const match = /^agent:([^:]+):/i.exec(normalized);
  return match?.[1]?.trim().toLowerCase() || 'main';
}

/** 构造飞书 thread conversationId。 */
export function buildFeishuConversationId(params: { chatId: string; threadId?: string }): string {
  const chatId = params.chatId.trim();
  const threadId = params.threadId?.trim();
  return chatId && threadId ? `${chatId}${TOPIC_SEPARATOR}${threadId}` : chatId;
}

/** 解析 `<chatId>:topic:<threadId>` conversationId。 */
export function parseFeishuConversationId(
  conversationId: string | undefined,
): { chatId: string; threadId?: string } | null {
  const normalized = normalizeOptionalString(conversationId);
  if (!normalized) {
    return null;
  }
  const separatorIndex = normalized.indexOf(TOPIC_SEPARATOR);
  if (separatorIndex < 0) {
    return { chatId: normalized };
  }
  const chatId = normalized.slice(0, separatorIndex).trim();
  const threadId = normalized.slice(separatorIndex + TOPIC_SEPARATOR.length).trim();
  if (!chatId) {
    return null;
  }
  return {
    chatId,
    threadId: threadId || undefined,
  };
}

/**
 * 解析 outbound 目标。
 *
 * 支持以下输入：
 * - `chat:oc_xxx`
 * - `channel:oc_xxx:topic:omt_xxx`
 * - `oc_xxx:topic:omt_xxx`
 * - 传统 `oc_xxx` / `ou_xxx`
 */
export function parseFeishuConversationTarget(rawTarget: string): ParsedFeishuConversationTarget {
  const trimmedTarget = rawTarget.trim();
  const withoutChannelPrefix = trimmedTarget.startsWith('channel:') ? trimmedTarget.slice('channel:'.length) : trimmedTarget;
  const withoutChatPrefix = withoutChannelPrefix.startsWith('chat:') ? withoutChannelPrefix.slice('chat:'.length) : withoutChannelPrefix;
  const parsedConversation = parseFeishuConversationId(withoutChatPrefix);

  if (!parsedConversation) {
    return {
      rawTarget: trimmedTarget,
      target: trimmedTarget,
      chatId: trimmedTarget,
    };
  }

  return {
    rawTarget: trimmedTarget,
    target: parsedConversation.chatId,
    chatId: parsedConversation.chatId,
    threadId: parsedConversation.threadId,
    conversationId: buildFeishuConversationId({
      chatId: parsedConversation.chatId,
      threadId: parsedConversation.threadId,
    }),
  };
}

function addBindingSessionIndex(record: FeishuThreadBindingRecord): void {
  const indexKey = resolveSessionKeyIndex(record.accountId, record.targetSessionKey);
  const existing = bindingsByAccountSession.get(indexKey) ?? new Set<string>();
  existing.add(resolveConversationKey(record.accountId, record.conversationId));
  bindingsByAccountSession.set(indexKey, existing);
}

function removeBindingSessionIndex(record: FeishuThreadBindingRecord): void {
  const indexKey = resolveSessionKeyIndex(record.accountId, record.targetSessionKey);
  const existing = bindingsByAccountSession.get(indexKey);
  if (!existing) {
    return;
  }
  existing.delete(resolveConversationKey(record.accountId, record.conversationId));
  if (existing.size === 0) {
    bindingsByAccountSession.delete(indexKey);
  }
}

export function upsertFeishuThreadBinding(params: {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  targetKind: FeishuBindingTargetKind;
  metadata?: Record<string, unknown>;
}): FeishuThreadBindingRecord | null {
  const accountId = params.accountId.trim().toLowerCase();
  const conversationId = params.conversationId.trim();
  const targetSessionKey = params.targetSessionKey.trim();
  if (!accountId || !conversationId || !targetSessionKey) {
    return null;
  }

  const now = Date.now();
  const bindingId = `feishu:${accountId}:${conversationId}`;
  const existing = bindingsByAccountConversation.get(resolveConversationKey(accountId, conversationId));
  if (existing) {
    removeBindingSessionIndex(existing);
  }

  const record: FeishuThreadBindingRecord = {
    bindingId,
    accountId,
    conversationId,
    parentConversationId: params.parentConversationId?.trim() || undefined,
    targetSessionKey,
    targetKind: params.targetKind,
    status: 'active',
    boundAt: existing?.boundAt ?? now,
    lastTouchedAt: now,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(params.metadata ?? {}),
    },
  };

  bindingsByAccountConversation.set(resolveConversationKey(accountId, conversationId), record);
  addBindingSessionIndex(record);
  log.info(`bound ${conversationId} -> ${targetSessionKey}`);
  return record;
}

export function resolveFeishuThreadBinding(params: {
  accountId: string;
  conversationId: string;
}): FeishuThreadBindingRecord | null {
  const key = resolveConversationKey(params.accountId, params.conversationId);
  return bindingsByAccountConversation.get(key) ?? null;
}

export function listFeishuThreadBindingsBySession(params: {
  accountId: string;
  targetSessionKey: string;
}): FeishuThreadBindingRecord[] {
  const indexKey = resolveSessionKeyIndex(params.accountId, params.targetSessionKey);
  const conversationKeys = bindingsByAccountSession.get(indexKey);
  if (!conversationKeys || conversationKeys.size === 0) {
    return [];
  }
  return [...conversationKeys]
    .map((conversationKey) => bindingsByAccountConversation.get(conversationKey))
    .filter((record): record is FeishuThreadBindingRecord => Boolean(record));
}

/**
 * 跨账号列出绑定，主要用于生命周期清理或 accountId 缺失时的兜底。
 */
export function listFeishuThreadBindingsBySessionAcrossAccounts(targetSessionKey: string): FeishuThreadBindingRecord[] {
  const normalizedSessionKey = targetSessionKey.trim();
  if (!normalizedSessionKey) {
    return [];
  }
  const records: FeishuThreadBindingRecord[] = [];
  for (const record of bindingsByAccountConversation.values()) {
    if (record.targetSessionKey === normalizedSessionKey) {
      records.push(record);
    }
  }
  return records;
}

export function touchFeishuThreadBinding(params: {
  accountId: string;
  conversationId: string;
  at?: number;
}): FeishuThreadBindingRecord | null {
  const record = resolveFeishuThreadBinding(params);
  if (!record) {
    return null;
  }
  record.lastTouchedAt = params.at ?? Date.now();
  return record;
}

export function unbindFeishuThreadBindings(params: {
  accountId: string;
  targetSessionKey?: string;
  conversationId?: string;
}): FeishuThreadBindingRecord[] {
  const removed: FeishuThreadBindingRecord[] = [];
  const accountId = params.accountId.trim().toLowerCase();

  if (params.conversationId?.trim()) {
    const record = resolveFeishuThreadBinding({
      accountId,
      conversationId: params.conversationId,
    });
    if (!record) {
      return removed;
    }
    bindingsByAccountConversation.delete(resolveConversationKey(accountId, record.conversationId));
    removeBindingSessionIndex(record);
    removed.push(record);
    return removed;
  }

  if (!params.targetSessionKey?.trim()) {
    return removed;
  }

  for (const record of listFeishuThreadBindingsBySession({
    accountId,
    targetSessionKey: params.targetSessionKey,
  })) {
    bindingsByAccountConversation.delete(resolveConversationKey(accountId, record.conversationId));
    removeBindingSessionIndex(record);
    removed.push(record);
  }
  return removed;
}

/**
 * 跨账号解绑指定 session 的所有 binding。
 */
export function unbindFeishuThreadBindingsAcrossAccounts(targetSessionKey: string): FeishuThreadBindingRecord[] {
  const normalizedSessionKey = targetSessionKey.trim();
  if (!normalizedSessionKey) {
    return [];
  }
  const removed: FeishuThreadBindingRecord[] = [];
  for (const record of listFeishuThreadBindingsBySessionAcrossAccounts(normalizedSessionKey)) {
    bindingsByAccountConversation.delete(resolveConversationKey(record.accountId, record.conversationId));
    removeBindingSessionIndex(record);
    removed.push(record);
  }
  return removed;
}

export function clearFeishuThreadBindings(accountId?: string): void {
  if (!accountId) {
    log.info(`clearing all feishu thread bindings (${bindingsByAccountConversation.size})`);
    bindingsByAccountConversation.clear();
    bindingsByAccountSession.clear();
    return;
  }
  const normalizedAccountId = accountId.trim().toLowerCase();
  let removedCount = 0;
  for (const [conversationKey, record] of bindingsByAccountConversation.entries()) {
    if (record.accountId !== normalizedAccountId) {
      continue;
    }
    bindingsByAccountConversation.delete(conversationKey);
    removeBindingSessionIndex(record);
    removedCount += 1;
  }
  log.info(`clearing feishu[${normalizedAccountId}] thread bindings (${removedCount})`);
}

export function runWithFeishuBindingInboundContext<T>(
  context: FeishuBindingInboundContext,
  run: () => Promise<T>,
): Promise<T> {
  return inboundContextStorage.run(context, run);
}

export function getCurrentFeishuBindingInboundContext(): FeishuBindingInboundContext | undefined {
  return inboundContextStorage.getStore();
}

export function bindCurrentFeishuThreadFromInboundContext(params: {
  targetSessionKey: string;
  targetKind: FeishuBindingTargetKind;
  metadata?: Record<string, unknown>;
}): FeishuThreadBindingRecord | null {
  const currentContext = getCurrentFeishuBindingInboundContext();
  const effectiveThreadId = currentContext?.effectiveThreadId?.trim();
  if (!currentContext || !effectiveThreadId) {
    return null;
  }

  const conversationId = buildFeishuConversationId({
    chatId: currentContext.chatId,
    threadId: effectiveThreadId,
  });

  return upsertFeishuThreadBinding({
    accountId: currentContext.accountId,
    conversationId,
    parentConversationId: currentContext.chatId,
    targetSessionKey: params.targetSessionKey,
    targetKind: params.targetKind,
    metadata: {
      ...(params.metadata ?? {}),
      anchorMessageId: currentContext.messageId,
      threadId: effectiveThreadId,
      parentChatId: currentContext.chatId,
      createdFromMessageId: currentContext.messageId,
      source: 'current',
    },
  });
}

function buildBootstrapPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

interface FeishuReplyResponseData {
  message_id?: string;
  chat_id?: string;
  thread_id?: string;
}

interface FeishuReplyResponse {
  data?: FeishuReplyResponseData;
}

async function sendBootstrapThreadReply(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  replyToMessageId: string;
  text: string;
}): Promise<FeishuReplyResponseData> {
  const sdk = LarkClient.fromCfg(params.cfg, params.accountId).sdk;
  const response = (await sdk.im.message.reply({
    path: { message_id: params.replyToMessageId },
    data: {
      content: buildBootstrapPostContent(params.text),
      msg_type: 'post',
      reply_in_thread: true,
    },
  })) as FeishuReplyResponse;

  return response.data ?? {};
}

export async function bootstrapFeishuChildThreadBinding(params: {
  targetSessionKey: string;
  targetKind: FeishuBindingTargetKind;
  metadata?: Record<string, unknown>;
}): Promise<FeishuBootstrapBindingResult | null> {
  const currentContext = getCurrentFeishuBindingInboundContext();
  if (!currentContext) {
    log.warn('bootstrap child binding skipped: missing inbound context');
    return null;
  }
  if (currentContext.effectiveThreadId) {
    const existing = bindCurrentFeishuThreadFromInboundContext(params);
    if (!existing) {
      return null;
    }
    const storedMetadata = toStoredBindingMetadata(existing.metadata);
    if (!storedMetadata.threadId || !storedMetadata.anchorMessageId) {
      return null;
    }
    return {
      binding: existing,
      threadId: storedMetadata.threadId,
      anchorMessageId: storedMetadata.anchorMessageId,
    };
  }

  const accountScopedCfg = createAccountScopedConfig(currentContext.cfg, currentContext.accountId);
  const introText = normalizeOptionalString(params.metadata?.introText) ?? DEFAULT_INTRO_TEXT;
  const replyData = await sendBootstrapThreadReply({
    cfg: accountScopedCfg,
    accountId: currentContext.accountId,
    replyToMessageId: currentContext.messageId,
    text: introText,
  });

  const anchorMessageId = normalizeOptionalString(replyData.message_id);
  const chatId = normalizeOptionalString(replyData.chat_id) ?? currentContext.chatId;
  let threadId = normalizeOptionalString(replyData.thread_id);

  // 有些链路不会直接把 thread_id 透给调用方，这里回查一次消息详情兜底。
  if (!threadId && anchorMessageId) {
    const lookedUpMessage = await getMessageFeishu({
      cfg: accountScopedCfg,
      accountId: currentContext.accountId,
      messageId: anchorMessageId,
    });
    threadId = lookedUpMessage?.threadId?.trim() || undefined;
  }

  if (!anchorMessageId || !threadId) {
    log.warn(`bootstrap child binding failed: anchor=${anchorMessageId ?? 'N/A'}, thread=${threadId ?? 'N/A'}`);
    return null;
  }

  const conversationId = buildFeishuConversationId({ chatId, threadId });
  const binding = upsertFeishuThreadBinding({
    accountId: currentContext.accountId,
    conversationId,
    parentConversationId: chatId,
    targetSessionKey: params.targetSessionKey,
    targetKind: params.targetKind,
    metadata: {
      ...(params.metadata ?? {}),
      anchorMessageId,
      threadId,
      parentChatId: chatId,
      createdFromMessageId: currentContext.messageId,
      source: 'child',
    },
  });

  if (!binding) {
    return null;
  }

  log.info(
    `bootstrap child binding created ${conversationId} -> ${params.targetSessionKey} ` +
      `(thread=${threadId}, anchor=${anchorMessageId})`,
  );

  return {
    binding,
    threadId,
    anchorMessageId,
  };
}

export function resolveFeishuSendTarget(params: {
  accountId?: string | null;
  rawTarget: string;
  replyToMessageId?: string | null;
  replyInThread?: boolean | null;
  threadId?: string | number | null;
}): FeishuResolvedSendTarget {
  const parsedTarget = parseFeishuConversationTarget(params.rawTarget);
  const explicitReplyToMessageId = normalizeOptionalString(params.replyToMessageId);
  const explicitThreadId =
    params.threadId != null && params.threadId !== '' ? String(params.threadId).trim() : undefined;

  const effectiveThreadId = parsedTarget.threadId ?? explicitThreadId;
  if (!effectiveThreadId) {
    return {
      target: parsedTarget.target,
      replyToMessageId: explicitReplyToMessageId,
      replyInThread: Boolean(explicitReplyToMessageId) && params.replyInThread === true,
    };
  }

  const accountId = normalizeOptionalString(params.accountId) ?? 'default';
  const conversationId =
    parsedTarget.conversationId ??
    buildFeishuConversationId({
      chatId: parsedTarget.chatId,
      threadId: effectiveThreadId,
    });
  const binding = resolveFeishuThreadBinding({
    accountId,
    conversationId,
  });
  const storedMetadata = toStoredBindingMetadata(binding?.metadata);
  const anchorMessageId = explicitReplyToMessageId ?? storedMetadata.anchorMessageId;

  if (!anchorMessageId) {
    throw new Error(
      `Feishu thread target "${conversationId}" is missing an anchor message. ` +
        '请先在该话题内完成一次绑定，或显式提供 replyToMessageId。',
    );
  }

  log.info(
    `resolved feishu thread target ${conversationId} -> chat=${parsedTarget.chatId} ` +
      `anchor=${anchorMessageId} thread=${effectiveThreadId}`,
  );

  return {
    target: parsedTarget.chatId,
    replyToMessageId: anchorMessageId,
    replyInThread: true,
    threadId: effectiveThreadId,
    conversationId,
  };
}
