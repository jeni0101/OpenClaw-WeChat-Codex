import COS from "cos-nodejs-sdk-v5";
import { createCos, loadCosSettings } from "../src/cos/client.js";

export async function configureCos(): Promise<Record<string, unknown>> {
  const settings = await loadCosSettings();
  const cos = createCos(settings);
  const bucketArgs = { Bucket: settings.bucket, Region: settings.region };
  let created = false;
  try {
    await cos.headBucket(bucketArgs);
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number }).statusCode ?? 0);
    if (statusCode !== 404) throw error;
    await cos.putBucket({ ...bucketArgs, ACL: "private" });
    created = true;
  }
  await cos.putBucketAcl({ ...bucketArgs, ACL: "private" });
  await cos.putBucketEncryption({
    ...bucketArgs,
    ServerSideEncryptionConfiguration: {
      Rule: [{ ApplySideEncryptionConfiguration: { SSEAlgorithm: "AES256" } }],
    },
  });
  const rules: COS.LifecycleRule[] = [
    { ID: "daily-30-days", Status: "Enabled", Filter: { Prefix: "daily/" }, Expiration: { Days: 30 } },
    { ID: "weekly-6-weeks", Status: "Enabled", Filter: { Prefix: "weekly/" }, Expiration: { Days: 43 } },
    { ID: "audit-90-days", Status: "Enabled", Filter: { Prefix: "audit/" }, Expiration: { Days: 90 } },
    { ID: "rollback-30-days", Status: "Enabled", Filter: { Prefix: "rollback/" }, Expiration: { Days: 30 } },
    { ID: "delivery-2-days", Status: "Enabled", Filter: { Prefix: "delivery/" }, Expiration: { Days: 2 } },
    {
      ID: "abort-incomplete-multipart-3-days",
      Status: "Enabled",
      Filter: { Prefix: "" },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
    },
  ];
  await cos.putBucketLifecycle({ ...bucketArgs, Rules: rules });
  const encryption = await cos.getBucketEncryption(bucketArgs);
  const lifecycle = await cos.getBucketLifecycle(bucketArgs);
  const acl = await cos.getBucketAcl(bucketArgs);
  if (acl.ACL !== "private") throw new Error(`bucket ACL verification failed: ${acl.ACL}`);
  return {
    bucket: settings.bucket,
    region: settings.region,
    created,
    privateAclVerified: true,
    websiteConfigured: false,
    cdnConfigured: false,
    encryption: encryption.ServerSideEncryptionConfiguration,
    lifecycleRules: lifecycle.Rules,
  };
}

configureCos().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
  process.exitCode = 1;
});
