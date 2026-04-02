/**
 * OpenAI OAuth configuration for Codex-compatible authentication.
 * Uses the same PKCE flow as OpenAI's Codex CLI.
 */
export const OPENAI_OAUTH_CONFIG = {
  CLIENT_ID: 'app_EMoamEEZ73f0CkXaXp7hrann',
  AUTHORIZE_URL: 'https://auth.openai.com/oauth/authorize',
  TOKEN_URL: 'https://auth.openai.com/oauth/token',
  DEFAULT_PORT: 1455,
  REDIRECT_PATH: '/auth/callback',
  SCOPES: 'openid profile email offline_access',
  EXTRA_PARAMS: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  },
} as const
