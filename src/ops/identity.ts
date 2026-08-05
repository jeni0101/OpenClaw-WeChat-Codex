import { runCommand } from "./process.js";

export interface ServiceIdentity {
  uid: number;
  gid: number;
}

export function parseServiceId(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value.trim())) {
    throw new Error(`${label} must be a positive numeric id`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new Error(`${label} is outside the supported range`);
  }
  return parsed;
}

async function lookup(flag: "-u" | "-g", user: string): Promise<number> {
  const result = await runCommand(["/usr/bin/id", flag, user], {
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  });
  if (result.code !== 0 || result.timedOut || result.truncated) {
    throw new Error(`unable to resolve ${flag === "-u" ? "uid" : "gid"} for ${user}`);
  }
  return parseServiceId(result.stdout, flag === "-u" ? "service uid" : "service gid");
}

export async function resolveServiceIdentity(user = "wechat-clawbot"): Promise<ServiceIdentity> {
  const explicitUid = process.env.WECHAT_CLAWBOT_UID;
  const explicitGid = process.env.WECHAT_CLAWBOT_GID;
  if ((explicitUid && !explicitGid) || (!explicitUid && explicitGid)) {
    throw new Error("WECHAT_CLAWBOT_UID and WECHAT_CLAWBOT_GID must be set together");
  }
  if (explicitUid && explicitGid) {
    return {
      uid: parseServiceId(explicitUid, "WECHAT_CLAWBOT_UID"),
      gid: parseServiceId(explicitGid, "WECHAT_CLAWBOT_GID"),
    };
  }
  return { uid: await lookup("-u", user), gid: await lookup("-g", user) };
}
