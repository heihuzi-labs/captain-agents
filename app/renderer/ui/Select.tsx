export type SelectItem = { id: string; label: string };
// 弹出菜单：macOS 系统设置那种小下拉按钮，显示当前值加一个小箭头，点开是系统原生菜单。
// 挑一个数（件数、百分比）或选项多于三四个时用它，比分段切换安静；放在设置行里时整行是 label，点标题也能打开。
export function Select({ label, items, value, onChange, disabled = false }: { label: string; items: SelectItem[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return <span className="select">
    <select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      {items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select>
    <i className="select-chevron" aria-hidden="true" />
  </span>;
}
