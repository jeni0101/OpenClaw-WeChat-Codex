declare module "@tencent-weixin/openclaw-weixin/dist/src/api/api.js" {
  export interface DiagnosticGetUploadUrlParams {
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
  }

  export interface DiagnosticGetUploadUrlResponse {
    ret?: number;
    errmsg?: string;
    upload_param?: string;
    upload_full_url?: string;
  }

  export function getUploadUrl(
    params: DiagnosticGetUploadUrlParams,
  ): Promise<DiagnosticGetUploadUrlResponse>;
}

declare module "@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js" {
  export interface DiagnosticUploadedFile {
    filekey: string;
    downloadEncryptedQueryParam: string;
    aeskey: string;
    fileSize: number;
    fileSizeCiphertext: number;
  }

  export function uploadFileAttachmentToWeixin(params: {
    filePath: string;
    fileName: string;
    toUserId: string;
    opts: {
      baseUrl: string;
      token?: string;
      timeoutMs?: number;
    };
    cdnBaseUrl: string;
  }): Promise<DiagnosticUploadedFile>;
}

declare module "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js" {
  import type { DiagnosticUploadedFile } from "@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js";

  export function sendFileMessageWeixin(params: {
    to: string;
    text: string;
    fileName: string;
    uploaded: DiagnosticUploadedFile;
    opts: {
      baseUrl: string;
      token?: string;
      timeoutMs?: number;
      contextToken?: string;
      runId?: string;
    };
  }): Promise<{ messageId: string }>;
}
