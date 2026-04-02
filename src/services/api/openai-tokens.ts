/**
 * OpenAI token persistence for OAuth-based authentication.
 * Stores tokens in ~/.claude/.openai-auth.json with mode 0600.
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const OPENAI_TOKEN_FILE = '.openai-auth.json'

function getOpenAITokenPath(): string {
  return join(getClaudeConfigHomeDir(), OPENAI_TOKEN_FILE)
}

export interface StoredOpenAITokens {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt: number
}

export function loadOpenAITokensSync(): StoredOpenAITokens | null {
  try {
    const data = JSON.parse(readFileSync(getOpenAITokenPath(), 'utf-8'))
    if (data.accessToken) {
      return data
    }
    return null
  } catch {
    return null
  }
}

export async function loadOpenAITokens(): Promise<StoredOpenAITokens | null> {
  const tokens = loadOpenAITokensSync()
  if (!tokens) return null

  // Check if token is expired (with 5-minute buffer)
  if (tokens.expiresAt < Date.now() + 5 * 60 * 1000) {
    if (tokens.refreshToken) {
      try {
        const { refreshOpenAIToken } = await import('../oauth/openai.js')
        const newTokens = await refreshOpenAIToken(tokens.refreshToken)
        saveOpenAITokens(newTokens)
        return newTokens
      } catch {
        return null
      }
    }
    return null
  }

  return tokens
}

export function saveOpenAITokens(tokens: StoredOpenAITokens): void {
  const tokenPath = getOpenAITokenPath()
  mkdirSync(dirname(tokenPath), { recursive: true })
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

export function clearOpenAITokens(): void {
  try {
    unlinkSync(getOpenAITokenPath())
  } catch {
    // ignore if file doesn't exist
  }
}
