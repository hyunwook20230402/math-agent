import { useState, useRef, useEffect } from 'react';
import { MathText } from './MathText';

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}

export function EditableMath({ value, onChange, placeholder, rows = 2, className }: Props) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const len = ref.current.value.length;
      ref.current.setSelectionRange(len, len);
    }
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        placeholder={placeholder}
        rows={rows}
        className={`w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className || ''}`}
      />
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      className={`w-full min-h-[2.5rem] rounded-md border border-input bg-background px-3 py-2 text-sm cursor-text hover:border-ring transition-colors ${className || ''}`}
      title="클릭하여 편집"
    >
      {value
        ? <MathText text={value} />
        : <span className="text-muted-foreground">{placeholder || '클릭하여 입력'}</span>}
    </div>
  );
}
