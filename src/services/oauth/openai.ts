/**
 * OpenAI OAuth 2.0 + PKCE authentication service.
 * Implements the same flow as OpenAI's Codex CLI.
 */
import axios from 'axios'
import { exec } from 'child_process'
import { createServer, type Server } from 'http'
import { OPENAI_OAUTH_CONFIG } from '../../constants/openai-oauth.js'
import { generateCodeChallenge, generateCodeVerifier, generateState } from './crypto.js'

export interface OpenAITokens {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt: number
}

function getRedirectUri(port: number): string {
  return `http://localhost:${port}${OPENAI_OAUTH_CONFIG.REDIRECT_PATH}`
}

export function buildOpenAIAuthUrl(codeChallenge: string, state: string, port: number): string {
  const url = new URL(OPENAI_OAUTH_CONFIG.AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OPENAI_OAUTH_CONFIG.CLIENT_ID)
  url.searchParams.set('redirect_uri', getRedirectUri(port))
  url.searchParams.set('scope', OPENAI_OAUTH_CONFIG.SCOPES)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  for (const [key, value] of Object.entries(OPENAI_OAUTH_CONFIG.EXTRA_PARAMS)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

export async function exchangeOpenAICode(
  code: string,
  codeVerifier: string,
  port: number,
): Promise<OpenAITokens> {
  const response = await axios.post(
    OPENAI_OAUTH_CONFIG.TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: getRedirectUri(port),
      client_id: OPENAI_OAUTH_CONFIG.CLIENT_ID,
      code_verifier: codeVerifier,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    },
  )

  if (response.status !== 200) {
    throw new Error(`OpenAI token exchange failed (${response.status}): ${response.statusText}`)
  }

  const data = response.data
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

export async function refreshOpenAIToken(refreshToken: string): Promise<OpenAITokens> {
  const response = await axios.post(
    OPENAI_OAUTH_CONFIG.TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CONFIG.CLIENT_ID,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    },
  )

  if (response.status !== 200) {
    throw new Error(`OpenAI token refresh failed (${response.status})`)
  }

  const data = response.data
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    idToken: data.id_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

/**
 * Open a URL in the default browser using platform-specific commands.
 */
function openBrowser(url: string): void {
  const platform = process.platform
  let command: string
  if (platform === 'darwin') {
    command = `open "${url}"`
  } else if (platform === 'win32') {
    command = `start "" "${url}"`
  } else {
    command = `xdg-open "${url}"`
  }
  exec(command, (err) => {
    if (err) {
      // If browser open fails, the URL has already been printed to stderr
    }
  })
}

/**
 * Run the complete OpenAI OAuth PKCE flow:
 * 1. Start local HTTP server for callback
 * 2. Open browser to auth URL
 * 3. Wait for callback with auth code
 * 4. Exchange code for tokens
 */
export async function runOpenAIOAuthFlow(): Promise<OpenAITokens> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  return new Promise((resolve, reject) => {
    let server: Server

    const cleanup = () => {
      try {
        server?.close()
      } catch {
        // ignore
      }
    }

    // Set a timeout of 5 minutes
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('OpenAI OAuth flow timed out after 5 minutes'))
    }, 5 * 60 * 1000)

    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://localhost`)
        if (url.pathname !== OPENAI_OAUTH_CONFIG.REDIRECT_PATH) {
          res.writeHead(404)
          res.end('Not found')
          return
        }

        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        const error = url.searchParams.get('error')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><h1>Authentication failed</h1><p>You can close this window.</p></body></html>')
          clearTimeout(timeout)
          cleanup()
          reject(new Error(`OpenAI OAuth error: ${error}`))
          return
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body><h1>Invalid callback</h1></body></html>')
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window and return to Claude Code.</p></body></html>')

        clearTimeout(timeout)

        try {
          const port = (server.address() as any)?.port ?? OPENAI_OAUTH_CONFIG.DEFAULT_PORT
          const tokens = await exchangeOpenAICode(code, codeVerifier, port)
          cleanup()
          resolve(tokens)
        } catch (err) {
          cleanup()
          reject(err)
        }
      } catch (err) {
        cleanup()
        reject(err)
      }
    })

    // Try the default Codex port first, fall back to random
    server.listen(OPENAI_OAUTH_CONFIG.DEFAULT_PORT, '127.0.0.1', () => {
      const port = (server.address() as any)?.port ?? OPENAI_OAUTH_CONFIG.DEFAULT_PORT
      const authUrl = buildOpenAIAuthUrl(codeChallenge, state, port)

      // biome-ignore lint/suspicious/noConsole: intentional
      console.error(`\nOpen this URL in your browser to authenticate:\n${authUrl}\n`)
      openBrowser(authUrl)
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Fall back to random port
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as any)?.port
          const authUrl = buildOpenAIAuthUrl(codeChallenge, state, port!)
          // biome-ignore lint/suspicious/noConsole: intentional
          console.error(`\nOpen this URL in your browser to authenticate:\n${authUrl}\n`)
          openBrowser(authUrl)
        })
      } else {
        clearTimeout(timeout)
        reject(err)
      }
    })
  })
}
