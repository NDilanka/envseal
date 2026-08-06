import type { ManifestEntry, SecretValue, VerifyResult } from '@envseal/protocol';
import type { ProjectPaths } from './paths.js';
import { isHostAllowlisted, isProbeApproved, recordProbeApproval } from './approvals.js';
import { redact } from './redact.js';
import { unsafeSecretToUtf8 } from './sinks/dotenv.js';

export interface VerifyOptions {
  timeoutMs?: number;
  onApprovalNeeded?: (entry: ManifestEntry) => Promise<boolean>;
}

export async function verifyKey(
  paths: ProjectPaths,
  entry: ManifestEntry,
  value: SecretValue,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  const now = new Date().toISOString();

  if (!entry.verify) {
    return {
      key: entry.key,
      result: 'no_probe',
      message: 'No verification probe configured',
      checkedAt: now,
    };
  }

  const { url, method, headerTemplate, expectStatus } = entry.verify;

  if (!url.startsWith('https://')) {
    return {
      key: entry.key,
      result: 'network_error',
      message: 'Probe URL must use https://',
      checkedAt: now,
    };
  }

  if (url.includes('{{value}}')) {
    return {
      key: entry.key,
      result: 'network_error',
      message: 'Probe URL must not contain {{value}}',
      checkedAt: now,
    };
  }

  const urlObj = new URL(url);
  const hostname = urlObj.hostname;
  const allowlisted = isHostAllowlisted(url);
  const approved = isProbeApproved(paths, entry);

  if (!allowlisted && !approved) {
    if (opts?.onApprovalNeeded) {
      const userApproved = await opts.onApprovalNeeded(entry);
      if (userApproved) {
        recordProbeApproval(paths, entry);
      } else {
        return {
          key: entry.key,
          result: 'probe_not_approved',
          message: `Probe to ${hostname} requires approval`,
          checkedAt: now,
        };
      }
    } else {
      return {
        key: entry.key,
        result: 'probe_not_approved',
        message: `Probe to ${hostname} requires approval`,
        checkedAt: now,
      };
    }
  }

  const valueStr = unsafeSecretToUtf8(value);
  const headers: Record<string, string> = {};

  for (const [key, templateVal] of Object.entries(headerTemplate)) {
    headers[key] = templateVal.replace(/\{\{value\}\}/g, valueStr);
  }

  const timeoutMs = opts?.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });

    const statusCode = response.status;
    const expectedStatuses = expectStatus ?? [200];

    if (expectedStatuses.includes(statusCode)) {
      return {
        key: entry.key,
        result: 'ok',
        message: `HTTP ${statusCode} from ${hostname}`,
        checkedAt: now,
      };
    }

    if (statusCode === 401) {
      return {
        key: entry.key,
        result: 'auth_failed',
        message: `HTTP 401 from ${hostname}`,
        checkedAt: now,
      };
    }

    if (statusCode === 403) {
      return {
        key: entry.key,
        result: 'forbidden',
        message: `HTTP 403 from ${hostname}`,
        checkedAt: now,
      };
    }

    if (statusCode === 429) {
      return {
        key: entry.key,
        result: 'rate_limited',
        message: `HTTP 429 from ${hostname}`,
        checkedAt: now,
      };
    }

    return {
      key: entry.key,
      result: 'auth_failed',
      message: `HTTP ${statusCode} from ${hostname}`,
      checkedAt: now,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    let result: VerifyResult['result'] = 'network_error';

    if (message.includes('abort')) {
      result = 'network_error';
    }

    const sanitized = redact(message, [value]).text;
    return {
      key: entry.key,
      result,
      message: sanitized,
      checkedAt: now,
    };
  } finally {
    clearTimeout(timeout);
  }
}
