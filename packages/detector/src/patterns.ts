import { allPrefixPatterns } from '@envseal/registry';

export interface SecretPattern {
  id: string;
  regex: RegExp;
  providerId?: string;
  confidence: 'high' | 'medium';
  label: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SW = '[A-Za-z0-9_\\-]';

interface HandPattern {
  id: string;
  label: string;
  providerId?: string;
  source: string;
}

const HAND_PATTERNS: HandPattern[] = [
  { id: 'openai-project-key', label: 'OpenAI project API key', providerId: 'openai', source: `sk-proj-${SW}{20,}` },
  // F5: legacy OpenAI live keys (`sk-live-…`) and bare `sk-` runs were not
  // covered — the W4 battle-test pasted `KEY=sk-live-w4bt…` straight through
  // the user-prompt redactor. Same shape family as sk-proj-, so same guard.
  { id: 'openai-legacy-key', label: 'OpenAI API key', providerId: 'openai', source: `sk-live-${SW}{20,}` },
  { id: 'openai-generic-key', label: 'possible OpenAI API key', providerId: 'openai', source: `sk-(?!proj-|live-)[A-Za-z0-9]{20,}` },
  { id: 'anthropic-api03', label: 'Anthropic API key', providerId: 'anthropic', source: `sk-ant-api03-${SW}{20,}` },
  { id: 'github-pat', label: 'GitHub personal access token', providerId: 'github', source: `ghp_${SW}{30,}` },
  { id: 'github-oauth', label: 'GitHub OAuth access token', providerId: 'github', source: `gho_${SW}{30,}` },
  { id: 'github-user', label: 'GitHub user-to-server token', providerId: 'github', source: `ghu_${SW}{30,}` },
  { id: 'github-app', label: 'GitHub server-to-server token', providerId: 'github', source: `ghs_${SW}{30,}` },
  { id: 'github-fine-grained', label: 'GitHub fine-grained token', providerId: 'github', source: `github_pat_[A-Za-z0-9_]{40,}` },
  { id: 'gitlab-pat', label: 'GitLab personal access token', providerId: 'gitlab', source: `glpat-${SW}{16,}` },
  { id: 'aws-access-key', label: 'AWS access key ID', providerId: 'aws', source: `AKIA[0-9A-Z]{16}` },
  { id: 'aws-qualified', label: 'AWS access key', providerId: 'aws', source: `(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=${SW}{16,}` },
  { id: 'sendgrid', label: 'SendGrid API key', providerId: 'sendgrid', source: `SG\\.[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}` },
  { id: 'stripe-secret', label: 'Stripe secret key', providerId: 'stripe', source: `sk_live_${SW}{24,}` },
  { id: 'stripe-publishable', label: 'Stripe publishable key', providerId: 'stripe', source: `pk_live_${SW}{24,}` },
  { id: 'stripe-restricted', label: 'Stripe restricted key', providerId: 'stripe', source: `rk_live_${SW}{24,}` },
  { id: 'google-api-key', label: 'Google API key', providerId: 'gcp', source: `AIza[0-9A-Za-z_\\-]{35}` },
  { id: 'slack-bot', label: 'Slack bot token', providerId: 'slack', source: `xoxb-${SW}{20,}` },
  { id: 'slack-user', label: 'Slack user token', providerId: 'slack', source: `xoxp-${SW}{20,}` },
  { id: 'slack-app', label: 'Slack app-level token', providerId: 'slack', source: `xoxa-${SW}{16,}` },
  { id: 'slack-app-env', label: 'Slack app env token', providerId: 'slack', source: `xapp-${SW}{24,}` },
  { id: 'digitalocean', label: 'DigitalOcean API token', providerId: 'digitalocean', source: `dop_v1_[A-Za-z0-9_]{32,}` },
  { id: 'shopify', label: 'Shopify access token', providerId: 'shopify', source: `shpat_[A-Za-z0-9_]{24,}` },
  { id: 'npm', label: 'npm access token', providerId: 'npm', source: `npm_${SW}{16,}` },
  { id: 'huggingface', label: 'Hugging Face token', providerId: 'huggingface', source: `hf_[A-Za-z0-9_]{16,}` },
  { id: 'groq', label: 'Groq API key', providerId: 'groq', source: `gsk_[A-Za-z0-9_]{24,}` },
  { id: 'openrouter-v1', label: 'OpenRouter v1 key', providerId: 'openrouter', source: `sk-or-v1-${SW}{32,}` },
  { id: 'resend', label: 'Resend API key', providerId: 'resend', source: `re_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}` },
  { id: 'private-key', label: 'Private key', source: `-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----` },
  { id: 'jwt', label: 'JWT token', source: `eyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+` },
  { id: 'conn-string', label: 'database connection string', source: `(?:postgres|postgresql|mysql|mongodb(?:\\+srv)?|redis|amqp)://[^:\\s/]+:[^@\\s]+@` },
];

export function allPatterns(): SecretPattern[] {
  const patterns: SecretPattern[] = [];

  for (const entry of allPrefixPatterns()) {
    if (entry.prefix === undefined) {
      continue;
    }
    // Two guards, both load-bearing for registry-derived patterns, which are
    // synthesised from a bare prefix and so are far weaker than the hand-written
    // ones:
    //
    // 1. A leading boundary. Without it a short prefix matches mid-identifier —
    //    Twilio's `AC` matched inside `REACT_APP_FEATURE_FLAG_ENABLED`, turning
    //    an ordinary env-var name into a "high confidence" credential hit.
    // 2. An alphanumeric-only body. Real key material is random alphanumerics;
    //    SCREAMING_SNAKE identifiers are not. Excluding `_` and `-` from the body
    //    stops the pattern from running through word separators.
    patterns.push({
      id: `registry:${entry.providerId}:${entry.envVar}`,
      regex: new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(entry.prefix)}[A-Za-z0-9]{16,}`, 'g'),
      providerId: entry.providerId,
      confidence: 'high',
      label: `${entry.providerId} ${entry.envVar}`,
    });
  }

  for (const hp of HAND_PATTERNS) {
    patterns.push({
      id: hp.id,
      regex: new RegExp(hp.source, 'g'),
      providerId: hp.providerId,
      confidence: 'high',
      label: hp.label,
    });
  }

  return patterns;
}
