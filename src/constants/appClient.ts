export const APP_CLIENT_REQUEST = 'bewly-app-client-request'

/** 后台只接受固定的 APP 接口，不透传任意 URL */
export type AppClientEndpoint
  = | 'qrcodeAuthCode'
    | 'qrcodePoll'
    | 'refreshTokenV3'
    | 'refreshTokenV2'
    | 'feedIndex'
    | 'feedDislike'
    | 'feedDislikeCancel'

export interface AppClientRequest {
  endpoint: AppClientEndpoint
  /** 未签名的参数，由后台补上 appkey / ts / sign */
  params: Record<string, string | number | boolean | null | undefined>
  /** 已授权账号的 mid，用于 x-bili-mid 等请求头 */
  mid?: number | null
}

export type AppClientProfile = 'login' | 'feed' | 'account'

export interface AppClientEndpointConfig {
  url: string
  method: 'GET' | 'POST'
  /** POST 时参数放在表单中；否则与 PiliPlus 一致放在 query 中 */
  form?: boolean
  profile: AppClientProfile
}

/**
 * APP 接口清单，后台与页面主世界桥共用。
 *
 * Safari 下由扩展后台发起的 fetch 会被算成扩展自身的 Origin
 * （safari-web-extension://<uuid>），B 站对 passport / app 接口直接返回
 * HTTP 412（WebKit bug 253696：扩展无法用 declarativeNetRequest 改写自己
 * 发起请求的请求头），所以 Safari 改由页面主世界代发。
 */
export const APP_CLIENT_ENDPOINTS: Record<AppClientEndpoint, AppClientEndpointConfig> = {
  qrcodeAuthCode: { url: 'https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', method: 'POST', profile: 'login' },
  qrcodePoll: { url: 'https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', method: 'POST', profile: 'login' },
  refreshTokenV3: { url: 'https://passport.bilibili.com/api/v3/oauth2/refresh_token', method: 'POST', form: true, profile: 'login' },
  refreshTokenV2: { url: 'https://passport.bilibili.com/api/v2/oauth2/refresh_token', method: 'POST', form: true, profile: 'login' },
  feedIndex: { url: 'https://app.bilibili.com/x/v2/feed/index', method: 'GET', profile: 'feed' },
  feedDislike: { url: 'https://app.bilibili.com/x/feed/dislike', method: 'GET', profile: 'account' },
  feedDislikeCancel: { url: 'https://app.bilibili.com/x/feed/dislike/cancel', method: 'GET', profile: 'account' },
}
