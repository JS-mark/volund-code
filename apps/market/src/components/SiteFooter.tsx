'use client'

import { useI18n } from './Providers'

export default function SiteFooterText() {
  const { t } = useI18n()
  return <>{t.footer}</>
}
