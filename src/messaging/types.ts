/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Messaging type definitions for the Lark/Feishu channel plugin.
 *
 * Pure shape types for inbound message events, normalised message context,
 * mention targets, and media metadata.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

export interface FeishuReactionCreatedEvent {
  message_id: string;
  chat_id?: string;
  chat_type?: 'p2p' | 'group' | 'private';
  reaction_type?: { emoji_type?: string };
  operator_type?: string;
  user_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  action_time?: string;
}

export interface FeishuBotAddedEvent {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
  name?: string;
  i18n_names?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
}

// ---------------------------------------------------------------------------
// Resource descriptor
// ---------------------------------------------------------------------------

/** Metadata describing a media resource in a message (no binary data). */
export interface ResourceDescriptor {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  /** image_key or file_key from the raw message content. */
  fileKey: string;
  /** Original file name (file/video messages). */
  fileName?: string;
  /** Duration in milliseconds (audio/video messages). */
  duration?: number;
  /** Video cover image key. */
  coverImageKey?: string;
}

// ---------------------------------------------------------------------------
// Mention info
// ---------------------------------------------------------------------------

/** Structured @mention information from a message. */
export interface MentionInfo {
  /** Placeholder key in raw content (e.g. "@_user_1"). */
  key: string;
  /** Feishu Open ID of the mentioned user. */
  openId: string;
  /** Display name. */
  name: string;
  /** Whether this mention targets the bot itself. */
  isBot: boolean;
}

// ---------------------------------------------------------------------------
// Inbound message context
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Raw event data (shape-mapped from FeishuMessageEvent)
// ---------------------------------------------------------------------------

/** Raw message body, directly mapped from FeishuMessageEvent.message. */
export interface RawMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  update_time?: string;
  chat_id: string;
  thread_id?: string;
  chat_type: 'p2p' | 'group';
  message_type: string;
  content: string;
  mentions?: Array<{
    key: string;
    id: { open_id?: string; user_id?: string; union_id?: string };
    name: string;
    tenant_key?: string;
  }>;
  user_agent?: string;
}

/** Raw sender data, directly mapped from FeishuMessageEvent.sender. */
export interface RawSender {
  sender_id: { open_id?: string; user_id?: string; union_id?: string };
  sender_type?: string;
  tenant_key?: string;
}

// ---------------------------------------------------------------------------
// Normalised inbound message context
// ---------------------------------------------------------------------------

/** Normalised representation of an inbound Feishu message. */
export interface MessageContext {
  // Core identifiers
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  chatType: 'p2p' | 'group';

  // Message content
  content: string;
  contentType: string;

  /** Media resource descriptors extracted during parsing. */
  resources: ResourceDescriptor[];
  /** All @mentions in the message (including bot). */
  mentions: MentionInfo[];

  // Message relationships
  rootId?: string;
  parentId?: string;
  /** 原始事件上的 thread_id。 */
  threadId?: string;
  /** 归一化后的话题 ID，优先用于后续 thread/conversation 语义。 */
  effectiveThreadId?: string;

  // Chat / thread capability
  /** 飞书 chat_mode，用于区分普通群、话题群与 p2p。 */
  chatMode?: 'group' | 'topic' | 'p2p';
  /** 普通群下的话题模式，thread 表示话题形式群。 */
  groupMessageType?: 'chat' | 'thread';

  // Timing
  createTime?: number;

  // Raw event data
  rawMessage: RawMessage;
  rawSender: RawSender;
}

/** @deprecated Use {@link MessageContext} instead. */
export type FeishuMessageContext = MessageContext;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/** Metadata about a media attachment received in or sent through Feishu. */
export interface FeishuMediaInfo {
  path: string;
  contentType?: string;
  placeholder: string;
  /** Original Feishu file_key / image_key that was downloaded. */
  fileKey: string;
  /** Resource type from the original descriptor. */
  resourceType: ResourceDescriptor['type'];
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/** Result of sending a message via the Feishu API. */
export interface FeishuSendResult {
  messageId: string;
  chatId: string;
  /** 当回复创建了新话题或消息本身位于话题中时，接口可能返回 thread_id。 */
  threadId?: string;
  /**
   * Human-readable warning when the send succeeded but with degradation
   * (e.g. media upload failed, fell back to a text link).
   *
   * Populated so upstream callers (and the AI) can detect that the
   * delivery was not fully as intended and take corrective action.
   */
  warning?: string;
}
