declare module "@tencent-weixin/openclaw-weixin/dist/src/api/api.js" {
  export function getUploadUrl(params: {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    filekey?: string;
    media_type?: number;
    to_user_id?: string;
    rawsize?: number;
    rawfilemd5?: string;
    filesize?: number;
    no_need_thumb?: boolean;
    aeskey?: string;
  }): Promise<{ ret?: number; errmsg?: string; upload_param?: string; upload_full_url?: string }>;
}

declare module "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js" {
  interface UploadedFile {
    filekey: string;
    downloadEncryptedQueryParam: string;
    aeskey: string;
    fileSize: number;
    fileSizeCiphertext: number;
  }
  interface SendOptions {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    contextToken?: string;
    runId?: string;
  }
  export function sendFileMessageWeixin(params: {
    to: string;
    text: string;
    fileName: string;
    uploaded: UploadedFile;
    opts: SendOptions;
  }): Promise<{ messageId: string }>;
  export function sendImageMessageWeixin(params: {
    to: string;
    text: string;
    uploaded: UploadedFile;
    opts: SendOptions;
  }): Promise<{ messageId: string }>;
  export function sendVideoMessageWeixin(params: {
    to: string;
    text: string;
    uploaded: UploadedFile;
    opts: SendOptions;
  }): Promise<{ messageId: string }>;
  export function sendMessageWeixin(params: {
    to: string;
    text: string;
    opts: SendOptions;
  }): Promise<{ messageId: string }>;
  export function sendMessageItemWeixin(params: {
    to: string;
    item: Record<string, unknown>;
    clientId?: string;
    label?: string;
    opts: SendOptions;
  }): Promise<{ messageId: string }>;
}
