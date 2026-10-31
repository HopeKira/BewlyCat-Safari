import type { AppClientEndpoint, AppClientRequest } from '~/constants/appClient'
import { APP_CLIENT_ENDPOINTS, APP_CLIENT_REQUEST } from '~/constants/appClient'
import type { AppAuthTokens } from '~/logic/appAuthStorage'
import { appAuthTokens, defaultAppAuthTokens, resetAppAuthTokens } from '~/logic/appAuthStorage'

import { waitWithSignal } from './abort'
import { HDAppKey, signAppParams } from './appSign'
import { sendMessage } from './messaging'
import { requestSafariMainWorldAppFetch } from './safariApiBridgeClient'
import { isSafariRuntime } from './safariRuntime'

export function revokeAccessKey() {
  resetAppAuthTokens()
}

const isSafari = isSafariRuntime()

/**
 * APP 接口交由后台按 PiliPlus 的请求方式签名并发出，参数无需在页面侧签名。
 *
 * Safari 例外：扩展后台发起的 fetch 会带上 safari-web-extension:// 的 Origin，
 * B 站 passport / app 接口对它一律返回 HTTP 412；而 WebKit 不允许扩展改写自己
 * 发起请求的请求头（bug 253696），所以这里改由页面主世界签名后直接发出，
 * 让请求带上真实的 https://www.bilibili.com Origin。
 */
export async function requestAppClient(endpoint: AppClientEndpoint, params: AppClientRequest['params']): Promise<any> {
  const target = Object.hasOwn(APP_CLIENT_ENDPOINTS, endpoint) ? APP_CLIENT_ENDPOINTS[endpoint] : undefined
  if (!target)
    return { code: -400, message: `Unknown APP client endpoint: ${endpoint}` }

  // 只有 passport 的登录 POST 需要换 Origin：
  // - 它校验 Origin，扩展后台的 safari-web-extension:// 会被判 412
  // - 它回 CORS 头，页面主世界能正常读到响应
  // 反之 app.bilibili.com 的推荐接口不回 ACAO（OPTIONS 405），页面上下文发不出去，
  // 但 GET 不校验 Origin，继续走后台反而正常。
  if (isSafari && target.profile === 'login') {
    try {
      const signed = new URLSearchParams(signAppParams(params ?? {}))
      const url = target.form ? target.url : `${target.url}?${signed}`
      const result = await requestSafariMainWorldAppFetch(
        url,
        target.method,
        target.form ? signed.toString() : undefined,
      )
      if (result.ok && result.data)
        return result.data
      return { code: -result.status, message: `HTTP ${result.status}` }
    }
    catch (error) {
      return { code: -1, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const request: AppClientRequest = { endpoint, params, mid: appAuthTokens.value.mid }
  return sendMessage(APP_CLIENT_REQUEST, request)
}

interface PollLoginTokenPayload {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  mid?: number
  token_info?: {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    mid?: number
  }
  refresh_token_info?: {
    expires_in?: number
  }
}

const APP_TOKEN_REFRESH_ENDPOINTS: AppClientEndpoint[] = ['refreshTokenV3', 'refreshTokenV2']
const APP_TOKEN_REFRESH_BUFFER = 10 * 60 * 1000
let appTokenRefresh: { tokens: AppAuthTokens, promise: Promise<AppAuthTokens | null> } | null = null

export function saveAppAuthTokens(payload: PollLoginTokenPayload) {
  const tokenInfo = payload.token_info || {}
  const refreshInfo = payload.refresh_token_info || {}

  const accessToken = payload.access_token || tokenInfo.access_token || ''
  const refreshToken = payload.refresh_token || tokenInfo.refresh_token || ''
  const expiresIn = tokenInfo.expires_in ?? payload.expires_in ?? null
  const refreshExpiresIn = refreshInfo.expires_in ?? null
  const mid = payload.mid ?? tokenInfo.mid ?? null

  appAuthTokens.value = {
    appKey: HDAppKey.appkey,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    refreshTokenExpiresAt: refreshExpiresIn ? Date.now() + refreshExpiresIn * 1000 : null,
    mid: mid ?? null,
    lastUpdatedAt: Date.now(),
  }
}

interface RefreshTokenResponse {
  code: number
  message?: string
  data?: {
    token_info?: {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      mid?: number
    }
    refresh_token_info?: {
      expires_in?: number
    }
  }
}

async function refreshAppTokens(tokens: AppAuthTokens): Promise<AppAuthTokens | null> {
  const { accessToken, refreshToken } = tokens
  if (!accessToken || !refreshToken)
    return null

  const ts = Math.floor(Date.now() / 1000)
  const basePayload = {
    access_token: accessToken,
    refresh_token: refreshToken,
    ts: ts.toString(),
  }

  for (const endpoint of APP_TOKEN_REFRESH_ENDPOINTS) {
    if (appAuthTokens.value !== tokens)
      return null

    try {
      const data = await requestAppClient(endpoint, basePayload) as RefreshTokenResponse
      // 撤销、重新授权和其他标签页的更新都会替换快照；旧请求不得恢复旧授权。
      if (appAuthTokens.value !== tokens)
        return null
      if (data.code !== 0 || !data.data)
        continue

      const tokenInfo = data.data.token_info || {}
      const refreshInfo = data.data.refresh_token_info || {}

      const nextAccessToken = tokenInfo.access_token || tokens.accessToken
      const nextRefreshToken = tokenInfo.refresh_token || tokens.refreshToken
      const expiresIn = tokenInfo.expires_in ?? null
      const refreshExpiresIn = refreshInfo.expires_in ?? null

      appAuthTokens.value = {
        appKey: tokens.appKey,
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
        accessTokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
        refreshTokenExpiresAt: refreshExpiresIn ? Date.now() + refreshExpiresIn * 1000 : tokens.refreshTokenExpiresAt,
        mid: tokenInfo.mid ?? tokens.mid,
        lastUpdatedAt: Date.now(),
      }
      return appAuthTokens.value
    }
    catch (error) {
      console.error('刷新 APP access_token 失败:', error)
    }
  }

  return null
}

export async function refreshAppAccessToken(): Promise<boolean> {
  return await refreshAppTokens(appAuthTokens.value) !== null
}

export async function ensureFreshAppAccessToken(bufferMs = APP_TOKEN_REFRESH_BUFFER): Promise<boolean> {
  const tokens = appAuthTokens.value
  if (!tokens.accessToken)
    return false

  const now = Date.now()
  if (!tokens.refreshToken) {
    return !tokens.accessTokenExpiresAt || tokens.accessTokenExpiresAt > now
  }

  if (tokens.refreshTokenExpiresAt && tokens.refreshTokenExpiresAt <= now) {
    resetAppAuthTokens()
    return false
  }

  // Legacy tokens may not have expiry metadata. Preserve their previous
  // behavior and let the actual APP request determine whether they still work.
  if (!tokens.accessTokenExpiresAt || tokens.accessTokenExpiresAt > now + bufferMs)
    return true

  if (!appTokenRefresh || appTokenRefresh.tokens !== tokens) {
    const refresh = {
      tokens,
      promise: refreshAppTokens(tokens)
        .finally(() => {
          if (appTokenRefresh === refresh)
            appTokenRefresh = null
        }),
    }
    appTokenRefresh = refresh
  }

  const refreshed = await appTokenRefresh.promise
  if (refreshed)
    return appAuthTokens.value === refreshed

  // A transient refresh failure should not block a token that has not actually
  // expired yet; the user request can still proceed with the remaining lifetime.
  return appAuthTokens.value === tokens
    && (tokens.accessTokenExpiresAt == null || tokens.accessTokenExpiresAt > Date.now())
}

export function hasValidAppAuthTokens(bufferMs = 5 * 60 * 1000) {
  const { accessToken, refreshToken, refreshTokenExpiresAt } = appAuthTokens.value
  if (!accessToken || !refreshToken)
    return false

  if (refreshTokenExpiresAt && refreshTokenExpiresAt < Date.now() + bufferMs)
    return false

  return true
}

export function clearAppAuthTokens() {
  appAuthTokens.value = { ...defaultAppAuthTokens }
}

// HD 版沿用 TV 扫码登录接口，只是改用 HD APPKEY 签名并标明 mobi_app，参数与 PiliPlus 一致。
export function pollAppLoginQRCode(authCode: string, signal?: AbortSignal): Promise<any> {
  return waitWithSignal(requestAppClient('qrcodePoll', { auth_code: authCode, local_id: '0' }), signal)
}

export function getAppLoginQRCode(signal?: AbortSignal): Promise<any> {
  return waitWithSignal(requestAppClient('qrcodeAuthCode', {
    local_id: '0',
    platform: 'android',
    mobi_app: HDAppKey.mobiApp,
  }), signal)
}
