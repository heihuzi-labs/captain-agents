import { useEffect, useRef, useState } from 'react';

// 取色框：拖动时（input）只改显示，松手（change）才把最后的颜色交给 onCommit。
// React 的 onChange 在拖动时也会触发，所以松手要单独听浏览器的 change。
export function ColorField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value), input = useRef<HTMLInputElement>(null), commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const done = () => commit.current(el.value);
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);
  return <input ref={input} type="color" className="field field-color" value={draft} onChange={e => setDraft(e.target.value)} />;
}
