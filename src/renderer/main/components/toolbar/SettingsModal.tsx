import LunaModal from 'luna-modal/react'
import LunaSetting, {
  LunaSettingButton,
  LunaSettingCheckbox,
  LunaSettingSelect,
  LunaSettingSeparator,
  LunaSettingTitle,
} from 'luna-setting/react'
import { notify } from 'share/renderer/lib/util'
import { t } from 'common/util'
import Style from './SettingsModal.module.scss'
import { createPortal } from 'react-dom'
import { useState, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import contain from 'licia/contain'
import debounce from 'licia/debounce'
import SettingPath from 'share/renderer/components/SettingPath'
import store from '../../store'
import { IModalProps } from 'share/common/types'

const notifyRequireReload = debounce(() => {
  notify(t('requireReload'), { icon: 'info' })
}, 1000)

export default observer(function SettingsModal(props: IModalProps) {
  const [scrcpyVersions, setScrcpyVersions] = useState<any>(null)

  useEffect(() => {
    if (props.visible) {
      main
        .scrcpyGetVersions()
        .then(setScrcpyVersions)
        .catch(() => {})
    }
  }, [props.visible])

  function onChange(key, val) {
    if (contain(['language', 'useNativeTitlebar'], key)) {
      notifyRequireReload()
    }
    store.settings.set(key, val)
  }

  async function checkScrcpy() {
    try {
      const versions = await main.scrcpyGetVersions()
      setScrcpyVersions(versions)
      if (versions.latest && versions.latest !== versions.installed) {
        await main.scrcpyUpdateNow(versions.latest)
        setScrcpyVersions(await main.scrcpyGetVersions())
        notify(`scrcpy ${versions.latest}`, { icon: 'success' })
      } else {
        notify(t('updateNotAvailable'), { icon: 'info' })
      }
    } catch (err) {
      notify(t('updateErr'), { icon: 'error' })
    }
  }

  return createPortal(
    <LunaModal
      title={t('settings')}
      width={400}
      visible={props.visible}
      onClose={props.onClose}
    >
      <LunaSetting className={Style.settings} onChange={onChange}>
        <LunaSettingTitle title={t('appearance')} />
        <LunaSettingSelect
          keyName="theme"
          value={store.settings.theme}
          title={t('theme')}
          options={{
            [t('sysPreference')]: 'system',
            [t('light')]: 'light',
            [t('dark')]: 'dark',
          }}
        />
        <LunaSettingSelect
          keyName="language"
          value={store.settings.language}
          title={t('language')}
          options={{
            [t('sysPreference')]: 'system',
            ['العربية']: 'ar',
            English: 'en-US',
            ['Français']: 'fr',
            ['Português']: 'pt',
            ['Español']: 'es',
            ['Русский']: 'ru',
            ['Türkçe']: 'tr',
            ['中文']: 'zh-CN',
            ['繁體中文']: 'zh-TW',
          }}
        />
        <LunaSettingCheckbox
          keyName="useNativeTitlebar"
          value={store.settings.useNativeTitlebar}
          description={t('useNativeTitlebar')}
        />
        <LunaSettingSeparator />
        <LunaSettingTitle title="ADB" />
        <SettingPath
          title={t('adbPath')}
          value={store.settings.adbPath}
          onChange={(val) => {
            notifyRequireReload()
            store.settings.set('adbPath', val)
          }}
          options={{
            properties: ['openFile'],
          }}
        />
        <LunaSettingCheckbox
          keyName="killAdbWhenExit"
          value={store.settings.killAdbWhenExit}
          description={t('killAdbWhenExit')}
        />
        <LunaSettingSeparator />
        <LunaSettingTitle title="scrcpy" />
        <LunaSettingCheckbox
          keyName="scrcpyAutoCheck"
          value={store.settings.scrcpyAutoCheck}
          description={t('scrcpyAutoCheck')}
        />
        <LunaSettingButton
          title={
            scrcpyVersions
              ? `scrcpy ${scrcpyVersions.installed}${
                  scrcpyVersions.latest &&
                  scrcpyVersions.latest !== scrcpyVersions.installed
                    ? ` → ${scrcpyVersions.latest}`
                    : ''
                }`
              : 'scrcpy'
          }
          description={t('checkUpdate')}
          onClick={checkScrcpy}
        />
        <LunaSettingButton
          description={t('restartAya')}
          onClick={() => main.relaunch()}
        />
      </LunaSetting>
    </LunaModal>,
    document.body
  )
})
