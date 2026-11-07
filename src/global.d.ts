// Safari 原生提供 promise 版 browser.* 命名空间（Safari 14+），因此不再打包
// webextension-polyfill；类型仍由 @types/webextension-polyfill 提供。
declare const browser: typeof import('webextension-polyfill')

interface Window {
  browser: typeof import('webextension-polyfill')
}

declare const __DEV__: boolean
declare const __BUILD_COMMIT__: string

declare module '*.vue' {
  const component: any
  export default component
}

declare module 'virtual:bewly-inject-messages' {
  /** `inject:` section of each locale file, keyed by locale then message key. */
  const messages: Record<string, Record<string, string>>
  export default messages
}
