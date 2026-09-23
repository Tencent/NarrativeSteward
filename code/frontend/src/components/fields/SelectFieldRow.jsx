// 下拉选择原子件：带标签的 <select>，选项为 {value, label} 列表。
export default function SelectFieldRow({ label, value, options = [], onChange, disabled = false }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      <select
        className="field-input"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
