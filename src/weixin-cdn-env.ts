export interface WeixinCdnChildEnvironment {
  WEIXIN_CDN_PRIMARY_METHOD: "POST" | "PUT";
  WEIXIN_CDN_PRIMARY_URL_SOURCE: "full" | "param";
  WEIXIN_CDN_SOCKS_PROXY: "socks5h://127.0.0.1:19080";
  WEIXIN_CDN_ALTERNATE_METHOD?: "POST" | "PUT";
}

export function validatedWeixinCdnChildEnvironment(
  environment: NodeJS.ProcessEnv,
): WeixinCdnChildEnvironment {
  const primaryMethod = environment.WEIXIN_CDN_PRIMARY_METHOD?.trim().toUpperCase();
  if (primaryMethod !== "POST" && primaryMethod !== "PUT") {
    throw new Error("WEIXIN_CDN_PRIMARY_METHOD must be POST or PUT");
  }

  const urlSource = environment.WEIXIN_CDN_PRIMARY_URL_SOURCE?.trim().toLowerCase();
  if (urlSource !== "full" && urlSource !== "param") {
    throw new Error("WEIXIN_CDN_PRIMARY_URL_SOURCE must be full or param");
  }

  const socksProxy = environment.WEIXIN_CDN_SOCKS_PROXY?.trim();
  if (socksProxy !== "socks5h://127.0.0.1:19080") {
    throw new Error("WEIXIN_CDN_SOCKS_PROXY must use the managed loopback tunnel");
  }

  const alternateMethod = environment.WEIXIN_CDN_ALTERNATE_METHOD?.trim().toUpperCase();
  if (
    alternateMethod !== undefined
    && alternateMethod !== ""
    && alternateMethod !== "POST"
    && alternateMethod !== "PUT"
  ) {
    throw new Error("WEIXIN_CDN_ALTERNATE_METHOD must be POST, PUT or unset");
  }

  return {
    WEIXIN_CDN_PRIMARY_METHOD: primaryMethod,
    WEIXIN_CDN_PRIMARY_URL_SOURCE: urlSource,
    WEIXIN_CDN_SOCKS_PROXY: socksProxy,
    ...(alternateMethod === "POST" || alternateMethod === "PUT"
      ? { WEIXIN_CDN_ALTERNATE_METHOD: alternateMethod }
      : {}),
  };
}
