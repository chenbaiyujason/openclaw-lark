/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu subagent thread-binding hooks.
 *
 * Since the plugin SDK does not yet expose the generic SessionBindingAdapter
 * registration API, we use plugin lifecycle hooks to provide a Feishu-local
 * approximation for thread-bound subagent sessions:
 * - create/bind current thread or bootstrap a child topic on spawn
 * - route completion messages back to the bound topic
 * - unbind when the spawned session ends
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { FeishuAccountConfig } from '../core/types';
import { getLarkAccount } from '../core/accounts';
import { larkLogger } from '../core/lark-logger';
import {
  bootstrapFeishuChildThreadBinding,
  listFeishuThreadBindingsBySession,
  listFeishuThreadBindingsBySessionAcrossAccounts,
  touchFeishuThreadBinding,
  unbindFeishuThreadBindings,
  unbindFeishuThreadBindingsAcrossAccounts,
} from './thread-bindings';

const log = larkLogger('channel/subagent-hooks');

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'unknown error';
}

function resolveFeishuThreadBindingFlags(cfg: FeishuAccountConfig | undefined): {
  enabled: boolean;
  autoCreate: boolean;
} {
  return {
    enabled: cfg?.acpThreadBindings !== false,
    autoCreate: cfg?.acpThreadBindingsAutoCreate === true,
  };
}

function resolveMatchingBoundOrigin(params: {
  childSessionKey: string;
  requesterAccountId?: string;
  requesterThreadId?: string;
}): {
  accountId: string;
  conversationId: string;
  threadId?: string;
} | null {
  const requesterAccountId = params.requesterAccountId?.trim();
  const requesterThreadId = params.requesterThreadId?.trim();
  const bindings = requesterAccountId
    ? listFeishuThreadBindingsBySession({
        accountId: requesterAccountId,
        targetSessionKey: params.childSessionKey,
      })
    : listFeishuThreadBindingsBySessionAcrossAccounts(params.childSessionKey);

  if (bindings.length === 0) {
    return null;
  }

  const matchedBinding =
    requesterThreadId != null && requesterThreadId !== ''
      ? bindings.find((binding) => binding.conversationId.endsWith(`:topic:${requesterThreadId}`))
      : bindings.length === 1
        ? bindings[0]
        : undefined;

  if (!matchedBinding) {
    return null;
  }

  const conversationId = matchedBinding.conversationId.trim();
  const threadId = conversationId.includes(':topic:')
    ? conversationId.slice(conversationId.lastIndexOf(':topic:') + ':topic:'.length).trim() || undefined
    : undefined;
  touchFeishuThreadBinding({
    accountId: matchedBinding.accountId,
    conversationId,
  });
  return {
    accountId: matchedBinding.accountId,
    conversationId,
    threadId,
  };
}

export function registerFeishuSubagentHooks(api: OpenClawPluginApi): void {
  api.on('subagent_spawning', async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const requesterChannel = event.requester?.channel?.trim().toLowerCase();
    if (requesterChannel !== 'feishu') {
      return;
    }

    const account = getLarkAccount(api.config, event.requester?.accountId);
    const flags = resolveFeishuThreadBindingFlags(account.config);
    if (!flags.enabled) {
      return {
        status: 'error' as const,
        error: 'Feishu 话题绑定已禁用，请开启 channels.feishu.acpThreadBindings。',
      };
    }

    if (!flags.autoCreate && !event.requester?.threadId) {
      return {
        status: 'error' as const,
        error: '当前不在飞书话题内，且未启用自动创建话题绑定（channels.feishu.acpThreadBindingsAutoCreate）。',
      };
    }

    try {
      const bindingResult = await bootstrapFeishuChildThreadBinding({
        targetSessionKey: event.childSessionKey,
        targetKind: 'subagent',
        metadata: {
          agentId: event.agentId,
          label: event.label,
          boundBy: 'system',
          introText:
            event.mode === 'session'
              ? `已为子代理 ${event.label ?? event.agentId} 创建独立话题，后续继续在本话题中交流。`
              : '已创建子任务话题，后续消息将继续发送到这里。',
        },
      });
      if (!bindingResult) {
        return {
          status: 'error' as const,
          error: '未能为 Feishu 子代理会话创建或绑定话题。',
        };
      }
      log.info(
        `subagent thread binding ready: ${bindingResult.binding.conversationId} -> ${event.childSessionKey} ` +
          `(thread=${bindingResult.threadId}, anchor=${bindingResult.anchorMessageId})`,
      );
      return {
        status: 'ok' as const,
        threadBindingReady: true,
      };
    } catch (error) {
      return {
        status: 'error' as const,
        error: `Feishu 话题绑定失败: ${summarizeError(error)}`,
      };
    }
  });

  api.on('subagent_delivery_target', (event) => {
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== 'feishu' || !event.expectsCompletionMessage) {
      return;
    }

    const matchedOrigin = resolveMatchingBoundOrigin({
      childSessionKey: event.childSessionKey,
      requesterAccountId: event.requesterOrigin?.accountId,
      requesterThreadId:
        event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ''
          ? String(event.requesterOrigin.threadId)
          : undefined,
    });
    if (!matchedOrigin) {
      return;
    }

    return {
      origin: {
        channel: 'feishu',
        accountId: matchedOrigin.accountId,
        to: `channel:${matchedOrigin.conversationId}`,
        ...(matchedOrigin.threadId ? { threadId: matchedOrigin.threadId } : {}),
      },
    };
  });

  api.on('subagent_ended', (event) => {
    const removedBindings = event.accountId?.trim()
      ? unbindFeishuThreadBindings({
          accountId: event.accountId,
          targetSessionKey: event.targetSessionKey,
        })
      : unbindFeishuThreadBindingsAcrossAccounts(event.targetSessionKey);
    if (removedBindings.length === 0) {
      return;
    }
    log.info(
      `subagent ended: removed ${removedBindings.length} feishu binding(s) for ${event.targetSessionKey} (${event.reason})`,
    );
  });
}
