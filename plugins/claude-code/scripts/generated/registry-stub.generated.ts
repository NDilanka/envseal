// Generated at build time from packages/registry/providers/*.json — do not edit.
type StubFormat = { prefix?: string; pattern?: string; example: string };
type StubKey = { envVar: string; format: StubFormat; rotateUrl?: string };
type StubProvider = { id: string; name: string; keys: StubKey[] };

const PROVIDERS = [
  {
    "id": "anthropic",
    "name": "Anthropic",
    "keys": [
      {
        "envVar": "ANTHROPIC_API_KEY",
        "format": {
          "prefix": "sk-ant-",
          "pattern": "^sk-ant-[A-Za-z0-9_-]{20,}$",
          "example": "sk-ant-XXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://console.anthropic.com/"
      }
    ]
  },
  {
    "id": "auth0",
    "name": "Auth0",
    "keys": [
      {
        "envVar": "AUTH0_DOMAIN",
        "format": {
          "example": "XXXXXXXX"
        }
      },
      {
        "envVar": "AUTH0_CLIENT_ID",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{24}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXX"
        }
      },
      {
        "envVar": "AUTH0_CLIENT_SECRET",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "aws",
    "name": "Amazon Web Services",
    "keys": [
      {
        "envVar": "AWS_ACCESS_KEY_ID",
        "format": {
          "prefix": "AKIA",
          "pattern": "^AKIA[0-9A-Z]{16}$",
          "example": "AKIA11111111111111XX"
        },
        "rotateUrl": "https://console.aws.amazon.com/iam/home#/security_credentials"
      },
      {
        "envVar": "AWS_SECRET_ACCESS_KEY",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{40}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://console.aws.amazon.com/iam/home#/security_credentials"
      }
    ]
  },
  {
    "id": "azure",
    "name": "Microsoft Azure",
    "keys": [
      {
        "envVar": "AZURE_SUBSCRIPTION_ID",
        "format": {
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
          "example": "11111111-1111-1111-1111-111111111111"
        }
      },
      {
        "envVar": "AZURE_CLIENT_ID",
        "format": {
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
          "example": "11111111-1111-1111-1111-111111111111"
        }
      },
      {
        "envVar": "AZURE_CLIENT_SECRET",
        "format": {
          "pattern": "^[A-Za-z0-9._~-]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "clerk",
    "name": "Clerk",
    "keys": [
      {
        "envVar": "CLERK_SECRET_KEY",
        "format": {
          "prefix": "sk_",
          "pattern": "^sk_[a-z]+_[A-Za-z0-9_-]{32,}$",
          "example": "sk_xxxx_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://dashboard.clerk.com/"
      },
      {
        "envVar": "CLERK_PUBLISHABLE_KEY",
        "format": {
          "prefix": "pk_",
          "pattern": "^pk_[a-z]+_[A-Za-z0-9_-]{32,}$",
          "example": "pk_xxxx_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "cloudflare",
    "name": "Cloudflare",
    "keys": [
      {
        "envVar": "CLOUDFLARE_API_TOKEN",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{40,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      },
      {
        "envVar": "CLOUDFLARE_ZONE_ID",
        "format": {
          "pattern": "^[a-f0-9]{32}$",
          "example": "11111111111111111111111111111111"
        }
      }
    ]
  },
  {
    "id": "cohere",
    "name": "Cohere",
    "keys": [
      {
        "envVar": "COHERE_API_KEY",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://dashboard.cohere.ai/api-keys"
      }
    ]
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "keys": [
      {
        "envVar": "DEEPSEEK_API_KEY",
        "format": {
          "prefix": "sk-",
          "pattern": "^sk-[A-Za-z0-9_-]{32,}$",
          "example": "sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://platform.deepseek.com/api_keys"
      }
    ]
  },
  {
    "id": "discord",
    "name": "Discord",
    "keys": [
      {
        "envVar": "DISCORD_BOT_TOKEN",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{24}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{38,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXX.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "firebase",
    "name": "Firebase",
    "keys": [
      {
        "envVar": "FIREBASE_API_KEY",
        "format": {
          "prefix": "AIza",
          "pattern": "^AIza[0-9A-Za-z_-]{35}$",
          "example": "AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "gcp",
    "name": "Google Cloud Platform",
    "keys": [
      {
        "envVar": "GOOGLE_APPLICATION_CREDENTIALS",
        "format": {
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "github",
    "name": "GitHub",
    "keys": [
      {
        "envVar": "GITHUB_TOKEN",
        "format": {
          "prefix": "ghp_",
          "pattern": "^(ghp_|github_pat_)[A-Za-z0-9_]{36,}$",
          "example": "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://github.com/settings/tokens"
      }
    ]
  },
  {
    "id": "gitlab",
    "name": "GitLab",
    "keys": [
      {
        "envVar": "GITLAB_TOKEN",
        "format": {
          "prefix": "glpat-",
          "pattern": "^glpat-[A-Za-z0-9_-]{20,}$",
          "example": "glpat-XXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://gitlab.com/-/user_settings/personal_access_tokens"
      }
    ]
  },
  {
    "id": "google-ai",
    "name": "Google AI Studio",
    "keys": [
      {
        "envVar": "GOOGLE_API_KEY",
        "format": {
          "prefix": "AIza",
          "pattern": "^AIza[0-9A-Za-z_-]{35}$",
          "example": "AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://makersuite.google.com/app/apikey"
      }
    ]
  },
  {
    "id": "groq",
    "name": "Groq",
    "keys": [
      {
        "envVar": "GROQ_API_KEY",
        "format": {
          "prefix": "gsk_",
          "pattern": "^gsk_[A-Za-z0-9_-]{32,}$",
          "example": "gsk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://console.groq.com/keys"
      }
    ]
  },
  {
    "id": "huggingface",
    "name": "Hugging Face",
    "keys": [
      {
        "envVar": "HUGGINGFACE_API_KEY",
        "format": {
          "prefix": "hf_",
          "pattern": "^hf_[A-Za-z0-9_-]{32,}$",
          "example": "hf_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://huggingface.co/settings/tokens"
      }
    ]
  },
  {
    "id": "linear",
    "name": "Linear",
    "keys": [
      {
        "envVar": "LINEAR_API_KEY",
        "format": {
          "prefix": "lin_",
          "pattern": "^lin_[A-Za-z0-9_-]{40,}$",
          "example": "lin_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://linear.app/settings/api"
      }
    ]
  },
  {
    "id": "mistral",
    "name": "Mistral AI",
    "keys": [
      {
        "envVar": "MISTRAL_API_KEY",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://console.mistral.ai/api-keys/"
      }
    ]
  },
  {
    "id": "mongodb",
    "name": "MongoDB",
    "keys": [
      {
        "envVar": "MONGODB_URI",
        "format": {
          "prefix": "mongodb://",
          "example": "mongodb://XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "mysql",
    "name": "MySQL",
    "keys": [
      {
        "envVar": "MYSQL_URL",
        "format": {
          "prefix": "mysql://",
          "example": "mysql://XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "neon",
    "name": "Neon",
    "keys": [
      {
        "envVar": "NEON_DATABASE_URL",
        "format": {
          "prefix": "postgres://",
          "example": "postgres://XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      },
      {
        "envVar": "NEON_API_KEY",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "netlify",
    "name": "Netlify",
    "keys": [
      {
        "envVar": "NETLIFY_TOKEN",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "notion",
    "name": "Notion",
    "keys": [
      {
        "envVar": "NOTION_API_KEY",
        "format": {
          "prefix": "ntn_",
          "pattern": "^ntn_[A-Za-z0-9_-]{64,}$",
          "example": "ntn_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://www.notion.so/my-integrations"
      }
    ]
  },
  {
    "id": "openai",
    "name": "OpenAI",
    "keys": [
      {
        "envVar": "OPENAI_API_KEY",
        "format": {
          "prefix": "sk-",
          "pattern": "^sk-[A-Za-z0-9_-]{20,}$",
          "example": "sk-XXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://platform.openai.com/account/api-keys"
      }
    ]
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "keys": [
      {
        "envVar": "OPENROUTER_API_KEY",
        "format": {
          "prefix": "sk-or-",
          "pattern": "^sk-or-[A-Za-z0-9_-]{32,}$",
          "example": "sk-or-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://openrouter.ai/keys"
      }
    ]
  },
  {
    "id": "planetscale",
    "name": "PlanetScale",
    "keys": [
      {
        "envVar": "PLANETSCALE_DATABASE_URL",
        "format": {
          "prefix": "mysql://",
          "example": "mysql://XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "postgres",
    "name": "PostgreSQL",
    "keys": [
      {
        "envVar": "DATABASE_URL",
        "format": {
          "prefix": "postgres://",
          "example": "postgres://XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "posthog",
    "name": "PostHog",
    "keys": [
      {
        "envVar": "POSTHOG_API_KEY",
        "format": {
          "prefix": "phc_",
          "pattern": "^phc_[A-Za-z0-9_-]{32,}$",
          "example": "phc_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "redis",
    "name": "Redis",
    "keys": [
      {
        "envVar": "REDIS_URL",
        "format": {
          "prefix": "redis://",
          "example": "redis://XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "resend",
    "name": "Resend",
    "keys": [
      {
        "envVar": "RESEND_API_KEY",
        "format": {
          "prefix": "re_",
          "pattern": "^re_[A-Za-z0-9_-]{32,}$",
          "example": "re_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://resend.com/api-keys"
      }
    ]
  },
  {
    "id": "sendgrid",
    "name": "SendGrid",
    "keys": [
      {
        "envVar": "SENDGRID_API_KEY",
        "format": {
          "prefix": "SG.",
          "pattern": "^SG\\.[A-Za-z0-9_-]{64,}$",
          "example": "SG.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://app.sendgrid.com/settings/api_keys"
      }
    ]
  },
  {
    "id": "sentry",
    "name": "Sentry",
    "keys": [
      {
        "envVar": "SENTRY_DSN",
        "format": {
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "slack",
    "name": "Slack",
    "keys": [
      {
        "envVar": "SLACK_BOT_TOKEN",
        "format": {
          "prefix": "xoxb-",
          "pattern": "^xoxb-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+-[A-Za-z0-9_-]{24,}$",
          "example": "xoxb-XXXX-XXXX-XXXXXXXXXXXXXXXXXXXXXXXX"
        }
      },
      {
        "envVar": "SLACK_SIGNING_SECRET",
        "format": {
          "pattern": "^[A-Za-z0-9]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "stripe",
    "name": "Stripe",
    "keys": [
      {
        "envVar": "STRIPE_SECRET_KEY",
        "format": {
          "prefix": "sk_test_",
          "pattern": "^sk_(live|test)_[A-Za-z0-9_-]{24,}$",
          "example": "sk_test_XXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://dashboard.stripe.com/apikeys"
      },
      {
        "envVar": "STRIPE_PUBLISHABLE_KEY",
        "format": {
          "prefix": "pk_test_",
          "pattern": "^pk_(live|test)_[A-Za-z0-9_-]{24,}$",
          "example": "pk_test_XXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "rotateUrl": "https://dashboard.stripe.com/apikeys"
      }
    ]
  },
  {
    "id": "supabase",
    "name": "Supabase",
    "keys": [
      {
        "envVar": "SUPABASE_URL",
        "format": {
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      },
      {
        "envVar": "SUPABASE_ANON_KEY",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      },
      {
        "envVar": "SUPABASE_SERVICE_ROLE_KEY",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{32,}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "twilio",
    "name": "Twilio",
    "keys": [
      {
        "envVar": "TWILIO_ACCOUNT_SID",
        "format": {
          "prefix": "AC",
          "pattern": "^AC[A-Za-z0-9]{32}$",
          "example": "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      },
      {
        "envVar": "TWILIO_AUTH_TOKEN",
        "format": {
          "pattern": "^[A-Za-z0-9]{32}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  },
  {
    "id": "vercel",
    "name": "Vercel",
    "keys": [
      {
        "envVar": "VERCEL_TOKEN",
        "format": {
          "pattern": "^[A-Za-z0-9_-]{24}$",
          "example": "XXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    ]
  }
] as StubProvider[];

export function allProviders(): StubProvider[] { return PROVIDERS; }

export function getProvider(id: string): StubProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function findKey(
  envVar: string,
): { provider: StubProvider; key: StubKey } | undefined {
  for (const provider of PROVIDERS) {
    const key = provider.keys.find((k) => k.envVar === envVar);
    if (key !== undefined) return { provider, key };
  }
  return undefined;
}

export function allProbeHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const provider of PROVIDERS) {
    for (const key of provider.keys) {
      if (key.format.pattern !== undefined) hosts.add(provider.id);
    }
  }
  return hosts;
}

export function allPrefixPatterns(): Array<{
  providerId: string;
  envVar: string;
  prefix?: string;
  pattern?: string;
}> {
  const out: Array<{ providerId: string; envVar: string; prefix?: string; pattern?: string }> = [];
  for (const provider of PROVIDERS) {
    for (const key of provider.keys) {
      out.push({
        providerId: provider.id,
        envVar: key.envVar,
        prefix: key.format.prefix,
        pattern: key.format.pattern,
      });
    }
  }
  return out;
}
