import { useLocale } from './LocaleContext.jsx'

/**
 * 顶栏的 CN/EN 界面语言切换。
 */
export default function LocaleSwitch() {
  const { locale, setLocale, showLocaleSwitch, t } = useLocale()
  if (!showLocaleSwitch) return null

  return (
    <div className="locale-switch" role="group" aria-label={t('common.language')}>
      <button
        type="button"
        className={locale === 'zh-CN' ? 'active' : ''}
        aria-pressed={locale === 'zh-CN'}
        onClick={() => setLocale('zh-CN')}
      >
        CN
      </button>
      <button
        type="button"
        className={locale === 'en-US' ? 'active' : ''}
        aria-pressed={locale === 'en-US'}
        onClick={() => setLocale('en-US')}
      >
        EN
      </button>
    </div>
  )
}
