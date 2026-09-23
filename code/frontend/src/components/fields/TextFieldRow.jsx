import { useAutoGrowTextarea } from '../../hooks/useAutoGrowTextarea'

/**
 * 文本字段原子件：单行 input 或多行 textarea，带标签。
 *
 * 多行框默认**按内容自适应高度**（autoGrow）：随内容增高，到 `maxHeight`（默认 320px）
 * 封顶后转为内部滚动；`rows` 作为初始/最小高度提示。隐藏（display:none）时跳过测量，
 * 避免被算成 0 高度而塌陷（见 DESIGN §5.7）。宽度变化时重算换行高度。
 *
 * @param {string} [label]
 * @param {string} value
 * @param {(v:string)=>void} onChange
 * @param {boolean} [multiline]
 * @param {number} [rows] 多行框的初始/最小行数
 * @param {boolean} [disabled]
 * @param {string} [placeholder]
 * @param {boolean} [autoGrow] 多行框是否按内容自适应高度（默认 true）
 * @param {number} [maxHeight] 自适应高度上限（px），超出后内部滚动
 * @param {string} [inputType] 单行输入类型
 * @param {number|string} [step] 数值输入步长
 * @param {boolean} [required] 是否必填
 * @param {number} [min] 数值下界
 * @param {number} [max] 数值上界
 * @param {string} [dataQuickstart] 可选的快速上手标记，写到外层 label。
 */
export default function TextFieldRow({
  label,
  value,
  onChange,
  multiline = false,
  rows = 3,
  disabled = false,
  placeholder = '',
  autoGrow = true,
  maxHeight = 320,
  inputType = 'text',
  step,
  required = false,
  min,
  max,
  dataQuickstart,
}) {
  const ref = useAutoGrowTextarea({
    value: value ?? '',
    enabled: Boolean(multiline && autoGrow),
    maxHeight,
  })

  return (
    <label className="field" data-quickstart={dataQuickstart || undefined}>
      {label && <span className="field-label">{label}</span>}
      {multiline ? (
        <textarea
          ref={ref}
          className={`field-input${autoGrow ? ' field-textarea-auto' : ''}`}
          value={value ?? ''}
          rows={rows}
          disabled={disabled}
          placeholder={placeholder}
          style={autoGrow ? { maxHeight } : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="field-input"
          type={inputType}
          value={value ?? ''}
          disabled={disabled}
          placeholder={placeholder}
          step={step}
          required={required}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  )
}
