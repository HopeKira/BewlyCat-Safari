import type { SafariApiDefinition, SafariAppFetchResult } from '~/utils/safariApi'
import {
  getSafariMainWorldApiDefinition,
  SAFARI_API_REQUEST,
  SAFARI_API_RESPONSE,
  SAFARI_APP_FETCH_REQUEST,
} from '~/utils/safariApi'
import { isSafariRuntime } from '~/utils/safariRuntime'

let isSetup = false

// 页面脚本同样能往 window.postMessage，所以这里必须锁死可代发的域名，
// 不能让主世界桥变成一个可被页面利用的任意请求代理。
const APP_FETCH_ALLOWED_HOSTS = new Set(['passport.bilibili.com', 'app.bilibili.com'])

export async function executeSafariAppFetch(
  url: string,
  method: string,
  body?: string,
): Promise<SafariAppFetchResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    throw new Error('APP client request rejected: invalid URL')
  }

  if (parsed.protocol !== 'https:' || !APP_FETCH_ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`APP client request rejected: ${parsed.hostname} is not allowed`)

  const init: RequestInit = {
    method,
    // APP 接口不能带网页 Cookie，否则会把 access key 绑到网页登录态上
    credentials: 'omit',
  }
  if (body) {
    init.body = body
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
  }

  const response = await fetch(url, init)
  const text = await response.text()
  let data: unknown = null
  // 412 时 B 站返回的是 HTML 错误页，解析失败要保留状态码而不是抛错
  try {
    data = text ? JSON.parse(text) : null
  }
  catch {
    data = null
  }

  return { ok: response.ok, status: response.status, data }
}

function appendSearchParams(url: string, params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '')
      searchParams.append(key, String(value))
  })
  return searchParams.size ? `${url}?${searchParams.toString()}` : url
}

function encodeFormBody(body: Record<string, unknown>): string {
  const bodyParams = new URLSearchParams()
  Object.entries(body).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '')
      bodyParams.append(key, String(value))
  })
  return bodyParams.toString()
}

function encodeRequestBody(definition: SafariApiDefinition, body: Record<string, unknown>): BodyInit | undefined {
  if (!Object.keys(body).length)
    return undefined
  if (definition.bodySerializer)
    return definition.bodySerializer(body)
  if (definition.headers?.['Content-Type']?.includes('application/json'))
    return JSON.stringify(body)
  return encodeFormBody(body) || undefined
}

export async function executeSafariApiRequest(
  namespace: string,
  apiName: string,
  options: Record<string, unknown> = {},
): Promise<unknown> {
  const definition = getSafariMainWorldApiDefinition(namespace, apiName)
  if (!definition)
    throw new Error(`Unknown Safari API: ${namespace}.${apiName}`)

  // 与后台 apiListenerFactory 的合并规则一致：body 与 params 同时声明的字段两边都写入。
  const defaultParams = definition.params ?? {}
  const defaultBody = definition.body ?? {}
  const params: Record<string, unknown> = { ...defaultParams }
  const body: Record<string, unknown> = { ...defaultBody }
  Object.entries(options).forEach(([key, value]) => {
    if (value === undefined)
      return
    if (defaultBody[key] !== undefined)
      body[key] = value
    if (defaultParams[key] !== undefined)
      params[key] = value
    else if (defaultBody[key] === undefined)
      params[key] = value
  })

  const response = await fetch(appendSearchParams(definition.url, params), {
    method: definition.method,
    headers: definition.headers,
    credentials: 'include',
    body: encodeRequestBody(definition, body),
  })
  return response.json()
}

export function setupSafariApiBridge() {
  if (isSetup || !isSafariRuntime())
    return

  isSetup = true
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object')
      return

    const { type, requestId, namespace, apiName, options } = event.data
    if (
      type !== SAFARI_API_REQUEST
      || typeof requestId !== 'string'
      || typeof namespace !== 'string'
      || typeof apiName !== 'string'
    ) {
      return
    }

    void executeSafariApiRequest(namespace, apiName, options)
      .then((data) => {
        window.postMessage({ type: SAFARI_API_RESPONSE, requestId, data }, '*')
      })
      .catch((error) => {
        window.postMessage({
          type: SAFARI_API_RESPONSE,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        }, '*')
      })
  })

  // APP 接口代发：复用同一套 requestId / SAFARI_API_RESPONSE 回包通道
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object')
      return

    const { type, requestId, url, method, body } = event.data
    if (
      type !== SAFARI_APP_FETCH_REQUEST
      || typeof requestId !== 'string'
      || typeof url !== 'string'
      || typeof method !== 'string'
    ) {
      return
    }

    void executeSafariAppFetch(url, method, typeof body === 'string' ? body : undefined)
      .then((data) => {
        window.postMessage({ type: SAFARI_API_RESPONSE, requestId, data }, '*')
      })
      .catch((error) => {
        window.postMessage({
          type: SAFARI_API_RESPONSE,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        }, '*')
      })
  })
}
