import browser from 'webextension-polyfill'

import { BILIBILI_DESKTOP_USER_AGENT, isPreventMobileRedirectEnabled } from '~/utils/bilibiliDesktopNavigation'
import { GET_BROWSER_INFO_MESSAGE, getExtensionBrowserInfo } from '~/utils/browserInfo'
import { onMessage } from '~/utils/messaging'

import { setupAppClient } from './appClient'
import { setupContentScriptRefreshPrompt } from './contentScriptRefreshPrompt'
import { setupExtensionCacheStore } from './extensionCacheStore'
import { setupLoginStateWatcher } from './loginStateWatcher'
import { setupApiMsgListeners } from './messageListeners/api'
import { setupTabMsgListeners } from './messageListeners/tabs'
import { setupSettingsCloudSync } from './settingsCloudSync'
import { setupSettingsStorageCoordinator } from './settingsStorageCoordinator'
import { setupTopBarStateBroker } from './topBarStateBroker'
import { setupWatchLaterStateBroker } from './watchLaterStateBroker'
import { initWbiKeys } from './wbiSign'

// Initialize extension and set up message handlers
browser.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed')
})

const PREVENT_MOBILE_REDIRECT_RULE_ID = 1001
const preventMobileRedirectRule: browser.DeclarativeNetRequest.Rule = {
  id: PREVENT_MOBILE_REDIRECT_RULE_ID,
  priority: 2,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      {
        header: 'user-agent',
        operation: 'set',
        value: BILIBILI_DESKTOP_USER_AGENT,
      },
      {
        header: 'sec-ch-ua-mobile',
        operation: 'set',
        value: '?0',
      },
      {
        header: 'sec-ch-ua-platform',
        operation: 'set',
        value: '"Windows"',
      },
    ],
  },
  condition: {
    regexFilter: '^https?://www\\.bilibili\\.com/',
    resourceTypes: ['main_frame'],
  },
}

let preventMobileRedirectEnabled = false

async function syncPreventMobileRedirectRule(enabled: boolean) {
  try {
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PREVENT_MOBILE_REDIRECT_RULE_ID],
      addRules: enabled ? [preventMobileRedirectRule] : [],
    })
  }
  catch (error) {
    console.error('[BewlyCat] Failed to update the mobile redirect compatibility rule:', error)
  }
}

let preventMobileRedirectApplied = false

function applyPreventMobileRedirectSetting(storedSettings: unknown) {
  const enabled = isPreventMobileRedirectEnabled(storedSettings)
  // 任一设置项变化都会触发；规则重建在浏览器主进程执行，开关未变时跳过。
  if (preventMobileRedirectApplied && enabled === preventMobileRedirectEnabled)
    return Promise.resolve()

  preventMobileRedirectApplied = true
  preventMobileRedirectEnabled = enabled
  return syncPreventMobileRedirectRule(enabled)
}

void browser.storage.local.get('settings').then((result) => {
  // 启动读取期间已收到变更时，变更值更新，不能被启动快照覆盖。
  if (!preventMobileRedirectApplied)
    return applyPreventMobileRedirectSetting(result.settings)
})

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.settings)
    return

  void applyPreventMobileRedirectSetting(changes.settings.newValue)
})

// 扩展启动时初始化 WBI 密钥
initWbiKeys().catch((error) => {
  console.error('[BewlyCat] WBI keys initialization error:', error)
})

// Setup all message listeners
setupSettingsStorageCoordinator()
setupSettingsCloudSync()
setupExtensionCacheStore()
setupApiMsgListeners()
setupAppClient()
setupTabMsgListeners()
setupTopBarStateBroker()
setupWatchLaterStateBroker()
setupContentScriptRefreshPrompt()
setupLoginStateWatcher()
onMessage(GET_BROWSER_INFO_MESSAGE, getExtensionBrowserInfo)
