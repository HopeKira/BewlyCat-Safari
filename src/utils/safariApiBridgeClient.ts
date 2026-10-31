import type { SafariAppFetchResult } from '~/utils/safariApi'
import { SAFARI_API_REQUEST, SAFARI_API_RESPONSE, SAFARI_APP_FETCH_REQUEST } from '~/utils/safariApi'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

const pendingRequests = new Map<string, PendingRequest>()
let requestIdCounter = 0
let responseListenerInstalled = false

function ensureResponseListener() {
  if (responseListenerInstalled || typeof window === 'undefined')
    return

  responseListenerInstalled = true
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object')
      return

    const { type, requestId, data, error } = event.data
    if (type !== SAFARI_API_RESPONSE || typeof requestId !== 'string')
      return

    const pending = pendingRequests.get(requestId)
    if (!pending)
      return

    pendingRequests.delete(requestId)
    clearTimeout(pending.timeout)
    if (typeof error === 'string')
      pending.reject(new Error(error))
    else
      pending.resolve(data)
  })
}

export function requestSafariMainWorldApi(
  namespace: string,
  apiName: string,
  options?: object,
): Promise<unknown> {
  ensureResponseListener()

  return new Promise((resolve, reject) => {
    const requestId = `bewly_api_${++requestIdCounter}_${Date.now()}`
    const timeout = setTimeout(() => {
      if (!pendingRequests.delete(requestId))
        return
      reject(new Error('Safari API request timeout'))
    }, 30000)

    pendingRequests.set(requestId, { resolve, reject, timeout })
    window.postMessage({
      type: SAFARI_API_REQUEST,
      requestId,
      namespace,
      apiName,
      options,
    }, '*')
  })
}

/**
 * 让页面主世界代发 APP 接口请求，绕开扩展后台 Origin 被 B 站 412 拦截的问题。
 * 回包复用 SAFARI_API_RESPONSE 通道，按 requestId 匹配。
 */
export function requestSafariMainWorldAppFetch(
  url: string,
  method: string,
  body?: string,
): Promise<SafariAppFetchResult> {
  ensureResponseListener()

  return new Promise((resolve, reject) => {
    const requestId = `bewly_app_${++requestIdCounter}_${Date.now()}`
    const timeout = setTimeout(() => {
      if (!pendingRequests.delete(requestId))
        return
      reject(new Error('Safari APP fetch timeout'))
    }, 15000)

    pendingRequests.set(requestId, {
      resolve: value => resolve(value as SafariAppFetchResult),
      reject,
      timeout,
    })
    window.postMessage({
      type: SAFARI_APP_FETCH_REQUEST,
      requestId,
      url,
      method,
      body,
    }, '*')
  })
}
