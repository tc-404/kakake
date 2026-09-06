/** 微信 iLink Bot 协议类型（参考 @tencent-weixin/openclaw-weixin / wx-robot-ilink） */

export const WEIXIN_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const WEIXIN_BOT_TYPE = '3';

export const WeixinMessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const WeixinMessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** getuploadurl 的 media_type */
export const WeixinUploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export const WeixinMessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface WeixinTextItem {
  text?: string;
}

export interface WeixinCDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface WeixinImageItem {
  media?: WeixinCDNMedia;
  mid_size?: number;
  hd_size?: number;
  aeskey?: string;
}

export interface WeixinVideoItem {
  media?: WeixinCDNMedia;
  video_size?: number;
  play_length?: number;
}

export interface WeixinFileItem {
  media?: WeixinCDNMedia;
  file_name?: string;
  len?: string;
  md5?: string;
}

export interface WeixinVoiceItem {
  media?: WeixinCDNMedia;
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  /** 毫秒 */
  playtime?: number;
  text?: string;
}

export interface WeixinMessageItem {
  type?: number;
  text_item?: WeixinTextItem;
  image_item?: WeixinImageItem;
  video_item?: WeixinVideoItem;
  file_item?: WeixinFileItem;
  voice_item?: WeixinVoiceItem;
  ref_msg?: { title?: string; message_item?: WeixinMessageItem };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

export interface WeixinGetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeixinGetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export interface WeixinQRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface WeixinQRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface WeixinLoginCredentials {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
}

export type WeixinMediaKind = 'image' | 'video' | 'file' | 'voice';

/** VoiceItem.encode_type */
export const WeixinVoiceEncodeType = {
  PCM: 1,
  ADPCM: 2,
  FEATURE: 3,
  SPEEX: 4,
  AMR: 5,
  SILK: 6,
  MP3: 7,
  OGG_SPEEX: 8,
} as const;
