import { useEffect, useState } from 'react'
import { formatAssetOperationStatus } from '../assetOperation'
import { useT } from '../i18n'

/**
 * 项目标题下方的配图操作进度：对象、阶段和已等待秒数。
 * 关闭卡片抽屉或切到试玩后仍可见，见 DESIGN §5.8。
 *
 * @param {object} props
 * @param {{projectId: string, category: string, cardName: string, action: string, startedAt: number}|null} [props.operation]
 */
export default function ProjectOperationStatus({ operation }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!operation) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [operation])

  if (!operation) return null
  return (
    <div className="build-global-status" role="status" aria-live="polite">
      {formatAssetOperationStatus(operation, now, t)}
    </div>
  )
}
